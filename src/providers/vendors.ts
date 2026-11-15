import { z } from 'zod';
import type { Analytics, Quote } from '../domain/quote.js';
import {
  type MarketDataProvider,
  ProviderSymbolUnknownError,
  ProviderUnavailableError,
} from './types.js';

/**
 * The transport each provider uses. Injected rather than imported so tests can
 * drive the normalisation logic without a network, and so a future change to
 * retry/proxy behaviour happens in one place.
 */
export type HttpGet = (url: string, signal: AbortSignal) => Promise<unknown>;

/** Real transport. Separated so the providers themselves stay pure-ish. */
export function createHttpGet(apiKeyHeader: string, apiKey: string): HttpGet {
  return async (url, signal) => {
    let response: Response;
    try {
      response = await fetch(url, { signal, headers: { [apiKeyHeader]: apiKey } });
    } catch (cause) {
      // Network-level failure: DNS, TLS, socket, or abort.
      throw new ProviderUnavailableError(url, cause);
    }
    if (response.status === 404) throw new ProviderSymbolUnknownError(url, '');
    if (!response.ok) throw new ProviderUnavailableError(url);
    return response.json();
  };
}

/* ------------------------------------------------------------------ *
 * Vendor A — prices in major units, seconds-since-epoch timestamps.
 * ------------------------------------------------------------------ */

const vendorASchema = z.object({
  c: z.number(), // current
  d: z.number(), // change
  dp: z.number(), // change percent
  t: z.number(), // epoch seconds
});

export class VendorAProvider implements MarketDataProvider {
  readonly name = 'vendor-a';
  readonly priority = 10;
  readonly supportsAnalytics = false;

  constructor(
    private readonly http: HttpGet,
    private readonly baseUrl: string,
  ) {}

  async getQuote(symbol: string, signal: AbortSignal): Promise<Quote> {
    const raw = await this.http(this.baseUrl + '/quote?symbol=' + encodeURIComponent(symbol), signal);
    const parsed = vendorASchema.safeParse(raw);
    if (!parsed.success) throw new ProviderUnavailableError(this.name, parsed.error);

    // A zero price from this vendor means "unknown symbol", not "free share".
    if (parsed.data.c === 0) throw new ProviderSymbolUnknownError(this.name, symbol);

    return {
      symbol: symbol.toUpperCase(),
      price: parsed.data.c,
      change: parsed.data.d,
      changePercent: parsed.data.dp,
      currency: 'USD',
      asOf: new Date(parsed.data.t * 1000),
      source: this.name,
    };
  }
}

/* ------------------------------------------------------------------ *
 * Vendor B — prices in cents, ISO timestamps, explicit currency.
 * ------------------------------------------------------------------ */

const vendorBSchema = z.object({
  ticker: z.string(),
  last_price_cents: z.number().int(),
  prev_close_cents: z.number().int(),
  currency: z.string().length(3),
  observed_at: z.string().datetime(),
});

export class VendorBProvider implements MarketDataProvider {
  readonly name = 'vendor-b';
  readonly priority = 20;
  readonly supportsAnalytics = false;

  constructor(
    private readonly http: HttpGet,
    private readonly baseUrl: string,
  ) {}

  async getQuote(symbol: string, signal: AbortSignal): Promise<Quote> {
    const raw = await this.http(this.baseUrl + '/v2/last/' + encodeURIComponent(symbol), signal);
    const parsed = vendorBSchema.safeParse(raw);
    if (!parsed.success) throw new ProviderUnavailableError(this.name, parsed.error);

    const { last_price_cents, prev_close_cents } = parsed.data;
    const price = last_price_cents / 100;
    const previous = prev_close_cents / 100;
    const change = round2(price - previous);

    return {
      symbol: parsed.data.ticker.toUpperCase(),
      price,
      change,
      // Guard against a zero previous close rather than emitting Infinity.
      changePercent: previous === 0 ? 0 : round2((change / previous) * 100),
      currency: parsed.data.currency.toUpperCase(),
      asOf: new Date(parsed.data.observed_at),
      source: this.name,
    };
  }
}

/* ------------------------------------------------------------------ *
 * Vendor C — analytics only: short interest and sentiment.
 * ------------------------------------------------------------------ */

const vendorCSchema = z.object({
  symbol: z.string(),
  short_interest_pct: z.number().nullable(),
  sentiment: z.number().min(-1).max(1).nullable(),
  as_of: z.string().datetime(),
});

export class VendorCProvider implements MarketDataProvider {
  readonly name = 'vendor-c';
  readonly priority = 30;
  readonly supportsAnalytics = true;

  constructor(
    private readonly http: HttpGet,
    private readonly baseUrl: string,
  ) {}

  async getQuote(_symbol: string, _signal: AbortSignal): Promise<Quote> {
    // This vendor sells analytics only. Declaring that honestly here beats
    // letting the service discover it through a runtime 404.
    throw new ProviderUnavailableError(this.name + ' does not serve quotes');
  }

  async getAnalytics(symbol: string, signal: AbortSignal): Promise<Analytics> {
    const raw = await this.http(this.baseUrl + '/analytics/' + encodeURIComponent(symbol), signal);
    const parsed = vendorCSchema.safeParse(raw);
    if (!parsed.success) throw new ProviderUnavailableError(this.name, parsed.error);

    return {
      symbol: parsed.data.symbol.toUpperCase(),
      shortInterestPercent: parsed.data.short_interest_pct,
      sentimentScore: parsed.data.sentiment,
      asOf: new Date(parsed.data.as_of),
      source: this.name,
    };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
