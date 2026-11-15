import type { Analytics, Quote } from '../domain/quote.js';

/**
 * Every vendor integration implements this. Keeping the surface this small is
 * deliberate: adding a fifth vendor should not require touching the service,
 * the cache or the HTTP layer.
 */
export interface MarketDataProvider {
  /** Stable identifier, used in cache keys, logs and circuit-breaker state. */
  readonly name: string;

  /**
   * Lower number wins. The service tries providers in priority order and stops
   * at the first success, so the cheapest or most accurate vendor goes first
   * and the others act as fallbacks.
   */
  readonly priority: number;

  /** Not every vendor sells analytics; the service skips those that do not. */
  readonly supportsAnalytics: boolean;

  /** Resolve a quote, or throw. Must not swallow errors — the breaker needs them. */
  getQuote(symbol: string, signal: AbortSignal): Promise<Quote>;

  /** Only called when supportsAnalytics is true. */
  getAnalytics?(symbol: string, signal: AbortSignal): Promise<Analytics>;
}

/** Raised by a provider when the vendor explicitly says it has no such symbol. */
export class ProviderSymbolUnknownError extends Error {
  constructor(provider: string, symbol: string) {
    super(provider + ' does not know symbol ' + symbol);
    this.name = 'ProviderSymbolUnknownError';
  }
}

/** Raised for transport failures, 5xx, and timeouts — these trip the breaker. */
export class ProviderUnavailableError extends Error {
  constructor(provider: string, cause?: unknown) {
    super('Provider ' + provider + ' is unavailable');
    this.name = 'ProviderUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}
