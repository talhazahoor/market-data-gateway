/**
 * A three-state circuit breaker.
 *
 * Why this exists: these vendors bill per call and rate-limit aggressively. When
 * one starts failing, hammering it costs money, burns the rate-limit budget that
 * the healthy path also needs, and adds latency to every request that is going
 * to fail anyway. The breaker fails fast instead and lets the service fall
 * through to the next vendor.
 *
 *   closed    — calls pass through; consecutive failures are counted
 *   open      — calls rejected immediately until resetTimeoutMs has elapsed
 *   half-open — a single trial call is allowed; success closes, failure re-opens
 */
export type BreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Consecutive failures before opening. */
  readonly failureThreshold: number;
  /** How long to stay open before allowing a trial call. */
  readonly resetTimeoutMs: number;
  /** Injectable clock, so tests do not have to sleep. */
  readonly now?: () => number;
}

export class CircuitOpenError extends Error {
  constructor(name: string) {
    super('Circuit breaker is open for ' + name);
    this.name = 'CircuitOpenError';
  }
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private trialInFlight = false;
  private readonly now: () => number;

  constructor(
    public readonly name: string,
    private readonly options: CircuitBreakerOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  get state(): BreakerState {
    if (this.failures < this.options.failureThreshold) return 'closed';
    if (this.now() - this.openedAt >= this.options.resetTimeoutMs) return 'half-open';
    return 'open';
  }

  /**
   * Run fn under the breaker. Throws CircuitOpenError without calling fn when
   * the circuit is open, so the caller can move on to the next provider.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.state;

    if (state === 'open') throw new CircuitOpenError(this.name);

    // In half-open, admit exactly one probe. Without this guard a burst of
    // concurrent requests would all be let through the moment the window
    // elapses, which is the stampede the breaker exists to prevent.
    if (state === 'half-open') {
      if (this.trialInFlight) throw new CircuitOpenError(this.name);
      this.trialInFlight = true;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    } finally {
      if (state === 'half-open') this.trialInFlight = false;
    }
  }

  /**
   * Record a failure that should not count against the vendor's health —
   * "symbol does not exist" is a correct answer, not an outage.
   */
  recordNeutral(): void {
    this.failures = 0;
  }

  private onSuccess(): void {
    this.failures = 0;
    this.openedAt = 0;
  }

  private onFailure(): void {
    this.failures += 1;
    if (this.failures >= this.options.failureThreshold) {
      this.openedAt = this.now();
    }
  }
}
