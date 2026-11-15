/**
 * The canonical shape this gateway returns, regardless of which vendor served it.
 *
 * Every vendor models a quote slightly differently: some send prices in cents,
 * some send timestamps in seconds, some use `ticker` and others `symbol`. The
 * normalisation step in each provider converts to this type so that nothing
 * downstream — cache, HTTP layer, consumers — has to know which vendor answered.
 */
export interface Quote {
  /** Uppercase ticker, e.g. "AAPL". */
  readonly symbol: string;
  /** Last traded price in major currency units (dollars, not cents). */
  readonly price: number;
  /** Absolute change against the previous close, in major units. */
  readonly change: number;
  /** Change against previous close as a percentage, e.g. -1.24 for -1.24%. */
  readonly changePercent: number;
  /** ISO-4217 code, e.g. "USD". */
  readonly currency: string;
  /** When the vendor says the quote was observed. */
  readonly asOf: Date;
  /** Which provider actually served this quote. Useful in support tickets. */
  readonly source: string;
}

/**
 * Short-interest and sentiment signals, which only some vendors carry.
 * Kept separate from Quote so a consumer that only needs a price does not
 * pay for a call to a vendor that charges per sentiment request.
 */
export interface Analytics {
  readonly symbol: string;
  /** Percentage of float currently sold short, e.g. 3.4 for 3.4%. */
  readonly shortInterestPercent: number | null;
  /** Normalised sentiment in [-1, 1]; negative is bearish. */
  readonly sentimentScore: number | null;
  readonly asOf: Date;
  readonly source: string;
}

/** Thrown when a symbol is syntactically fine but no vendor recognises it. */
export class SymbolNotFoundError extends Error {
  constructor(public readonly symbol: string) {
    super('No provider returned data for symbol ' + symbol);
    this.name = 'SymbolNotFoundError';
  }
}

/** Thrown when every configured provider failed or is circuit-open. */
export class AllProvidersUnavailableError extends Error {
  constructor(public readonly attempted: readonly string[]) {
    super('All providers unavailable: ' + attempted.join(', '));
    this.name = 'AllProvidersUnavailableError';
  }
}
