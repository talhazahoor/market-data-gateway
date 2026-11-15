import { analyticsKey, quoteKey, type Cache } from './cache/cache.js';
import {
  AllProvidersUnavailableError,
  SymbolNotFoundError,
  type Analytics,
  type Quote,
} from './domain/quote.js';
import {
  ProviderSymbolUnknownError,
  type MarketDataProvider,
} from './providers/types.js';
import { CircuitBreaker, type CircuitBreakerOptions } from './resilience/circuitBreaker.js';

export interface QuoteServiceOptions {
  readonly quoteTtlSeconds: number;
  readonly analyticsTtlSeconds: number;
  readonly providerTimeoutMs: number;
  readonly breaker: CircuitBreakerOptions;
}

type Logger = { warn: (obj: object, msg: string) => void };

/**
 * Orchestrates cache, providers and circuit breakers.
 *
 * Read path for a quote:
 *   1. Cache hit            -> return it.
 *   2. Identical request already in flight -> await that one (single-flight).
 *   3. Try providers by priority. First success wins and is cached.
 *   4. A vendor saying "no such symbol" is authoritative: stop, 404.
 *   5. Everything failed    -> AllProvidersUnavailableError (503).
 */
export class QuoteService {
  private readonly breakers = new Map<string, CircuitBreaker>();
  /** De-duplicates concurrent identical lookups so one miss causes one call. */
  private readonly inFlight = new Map<string, Promise<Quote>>();
  private readonly providers: readonly MarketDataProvider[];

  constructor(
    providers: readonly MarketDataProvider[],
    private readonly cache: Cache,
    private readonly options: QuoteServiceOptions,
    private readonly logger: Logger = { warn: () => {} },
  ) {
    // Sort once at construction rather than on every request.
    this.providers = [...providers].sort((a, b) => a.priority - b.priority);
    for (const p of this.providers) {
      this.breakers.set(p.name, new CircuitBreaker(p.name, options.breaker));
    }
  }

  async getQuote(symbol: string): Promise<Quote> {
    const normalised = symbol.trim().toUpperCase();
    const key = quoteKey(normalised);

    const cached = await this.cache.get<Quote>(key);
    if (cached) return reviveQuote(cached);

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const pending = this.fetchQuote(normalised, key).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, pending);
    return pending;
  }

  async getAnalytics(symbol: string): Promise<Analytics> {
    const normalised = symbol.trim().toUpperCase();
    const key = analyticsKey(normalised);

    const cached = await this.cache.get<Analytics>(key);
    if (cached) return reviveAnalytics(cached);

    const attempted: string[] = [];
    for (const provider of this.providers) {
      if (!provider.supportsAnalytics || !provider.getAnalytics) continue;
      attempted.push(provider.name);
      const breaker = this.breakers.get(provider.name);
      if (!breaker) continue;

      try {
        const result = await breaker.execute(() =>
          this.withTimeout((signal) => provider.getAnalytics!(normalised, signal)),
        );
        await this.cache.set(key, result, this.options.analyticsTtlSeconds);
        return result;
      } catch (error) {
        if (error instanceof ProviderSymbolUnknownError) {
          breaker.recordNeutral();
          throw new SymbolNotFoundError(normalised);
        }
        this.logger.warn({ provider: provider.name, symbol: normalised }, 'analytics lookup failed');
      }
    }
    throw new AllProvidersUnavailableError(attempted);
  }

  /** Current breaker state per provider — surfaced on /health for operators. */
  breakerStates(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, breaker] of this.breakers) out[name] = breaker.state;
    return out;
  }

  private async fetchQuote(symbol: string, key: string): Promise<Quote> {
    const attempted: string[] = [];

    for (const provider of this.providers) {
      const breaker = this.breakers.get(provider.name);
      if (!breaker) continue;
      attempted.push(provider.name);

      try {
        const quote = await breaker.execute(() =>
          this.withTimeout((signal) => provider.getQuote(symbol, signal)),
        );
        await this.cache.set(key, quote, this.options.quoteTtlSeconds);
        return quote;
      } catch (error) {
        // The vendor answered correctly and the answer is "no such symbol".
        // That is not an outage, so it must not count against the breaker,
        // and asking the next vendor would waste a paid call for the same no.
        if (error instanceof ProviderSymbolUnknownError) {
          breaker.recordNeutral();
          throw new SymbolNotFoundError(symbol);
        }
        this.logger.warn(
          { provider: provider.name, symbol, state: breaker.state },
          'quote lookup failed, falling through',
        );
      }
    }

    throw new AllProvidersUnavailableError(attempted);
  }

  /**
   * Caps how long any single vendor may take. Without this a slow vendor holds
   * a connection open and the fallback never gets a chance to run.
   */
  private async withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.providerTimeoutMs);
    try {
      return await fn(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** JSON has no Date type, so a cached quote comes back with asOf as a string. */
function reviveQuote(raw: Quote): Quote {
  return { ...raw, asOf: new Date(raw.asOf) };
}

function reviveAnalytics(raw: Analytics): Analytics {
  return { ...raw, asOf: new Date(raw.asOf) };
}
