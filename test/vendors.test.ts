import { describe, expect, it } from 'vitest';
import {
  ProviderSymbolUnknownError,
  ProviderUnavailableError,
} from '../src/providers/types.js';
import { VendorAProvider, VendorBProvider, VendorCProvider } from '../src/providers/vendors.js';

const signal = new AbortController().signal;

/** Returns a transport that always answers with the given payload. */
const serving = (payload: unknown) => async () => payload;

describe('vendor normalisation', () => {
  it('converts vendor A epoch seconds to a Date', async () => {
    const provider = new VendorAProvider(
      serving({ c: 185.5, d: -2.5, dp: -1.33, t: 1767225600 }),
      'https://a.test',
    );
    const quote = await provider.getQuote('aapl', signal);

    expect(quote.symbol).toBe('AAPL');
    expect(quote.price).toBe(185.5);
    expect(quote.asOf.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(quote.source).toBe('vendor-a');
  });

  it('treats a zero price from vendor A as an unknown symbol', async () => {
    const provider = new VendorAProvider(serving({ c: 0, d: 0, dp: 0, t: 1767225600 }), 'https://a.test');
    await expect(provider.getQuote('NOPE', signal)).rejects.toBeInstanceOf(
      ProviderSymbolUnknownError,
    );
  });

  it('converts vendor B cents to major units and derives the percentage', async () => {
    const provider = new VendorBProvider(
      serving({
        ticker: 'msft',
        last_price_cents: 41000,
        prev_close_cents: 40000,
        currency: 'usd',
        observed_at: '2026-01-01T00:00:00.000Z',
      }),
      'https://b.test',
    );
    const quote = await provider.getQuote('msft', signal);

    expect(quote.price).toBe(410);
    expect(quote.change).toBe(10);
    expect(quote.changePercent).toBe(2.5);
    expect(quote.currency).toBe('USD');
  });

  it('does not divide by zero when vendor B reports no previous close', async () => {
    const provider = new VendorBProvider(
      serving({
        ticker: 'IPO',
        last_price_cents: 2500,
        prev_close_cents: 0,
        currency: 'USD',
        observed_at: '2026-01-01T00:00:00.000Z',
      }),
      'https://b.test',
    );
    const quote = await provider.getQuote('IPO', signal);

    expect(quote.changePercent).toBe(0);
    expect(Number.isFinite(quote.changePercent)).toBe(true);
  });

  it('rejects a malformed payload rather than passing it downstream', async () => {
    const provider = new VendorAProvider(serving({ unexpected: true }), 'https://a.test');
    await expect(provider.getQuote('AAPL', signal)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });

  it('maps vendor C analytics and preserves explicit nulls', async () => {
    const provider = new VendorCProvider(
      serving({
        symbol: 'gme',
        short_interest_pct: 21.4,
        sentiment: null,
        as_of: '2026-01-01T00:00:00.000Z',
      }),
      'https://c.test',
    );
    const analytics = await provider.getAnalytics('gme', signal);

    expect(analytics.symbol).toBe('GME');
    expect(analytics.shortInterestPercent).toBe(21.4);
    // null means "vendor has no reading", which is different from 0 (neutral).
    expect(analytics.sentimentScore).toBeNull();
  });

  it('refuses quote requests on the analytics-only vendor', async () => {
    const provider = new VendorCProvider(serving({}), 'https://c.test');
    await expect(provider.getQuote('AAPL', signal)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });
});
