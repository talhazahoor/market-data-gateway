import { describe, expect, it, vi } from 'vitest';
import { analyticsKey, MemoryCache } from '../src/cache/cache.js';
import {
  AllProvidersUnavailableError,
  SymbolNotFoundError,
  type Analytics,
  type Quote,
} from '../src/domain/quote.js';
import {
  ProviderSymbolUnknownError,
  ProviderUnavailableError,
  type MarketDataProvider,
} from '../src/providers/types.js';
import { QuoteService, type QuoteServiceOptions } from '../src/quoteService.js';

const options: QuoteServiceOptions = {
  quoteTtlSeconds: 5,
  analyticsTtlSeconds: 60,
  providerTimeoutMs: 50,
  breaker: { failureThreshold: 2, resetTimeoutMs: 1000 },
};

const noQuotes: MarketDataProvider['getQuote'] = async () => {
  throw new ProviderUnavailableError('quotes not served here');
};

function analytics(symbol: string, source: string): Analytics {
  return {
    symbol,
    shortInterestPercent: 12.5,
    sentimentScore: -0.4,
    asOf: new Date('2026-01-01T00:00:00.000Z'),
    source,
  };
}

function analyticsProvider(
  name: string,
  priority: number,
  getAnalytics: NonNullable<MarketDataProvider['getAnalytics']>,
): MarketDataProvider {
  return { name, priority, supportsAnalytics: true, getQuote: noQuotes, getAnalytics };
}

describe('QuoteService.getAnalytics', () => {
  it('returns analytics from the first capable provider', async () => {
    const service = new QuoteService(
      [analyticsProvider('c', 10, async () => analytics('GME', 'c'))],
      new MemoryCache(),
      options,
    );

    const result = await service.getAnalytics('gme');
    expect(result).toMatchObject({ symbol: 'GME', shortInterestPercent: 12.5, source: 'c' });
  });

  it('skips providers that do not sell analytics', async () => {
    const quoteOnly = vi.fn(async (): Promise<Quote> => {
      throw new Error('should never be called for analytics');
    });
    const service = new QuoteService(
      [
        { name: 'quotes-only', priority: 1, supportsAnalytics: false, getQuote: quoteOnly },
        analyticsProvider('c', 10, async () => analytics('GME', 'c')),
      ],
      new MemoryCache(),
      options,
    );

    await expect(service.getAnalytics('GME')).resolves.toMatchObject({ source: 'c' });
    expect(quoteOnly).not.toHaveBeenCalled();
  });

  it('caches the result under the analytics namespace', async () => {
    const provider = vi.fn(async () => analytics('GME', 'c'));
    const cache = new MemoryCache();
    const service = new QuoteService([analyticsProvider('c', 10, provider)], cache, options);

    await service.getAnalytics('GME');
    expect(await cache.get(analyticsKey('GME'))).not.toBeNull();

    await service.getAnalytics('GME');
    expect(provider).toHaveBeenCalledOnce();
  });

  it('revives asOf as a Date on a cache hit', async () => {
    const cache = new MemoryCache();
    const serialised = JSON.parse(JSON.stringify(analytics('GME', 'c'))) as Analytics;
    await cache.set(analyticsKey('GME'), serialised, 60);

    const service = new QuoteService([], cache, options);
    const result = await service.getAnalytics('GME');
    expect(result.asOf).toBeInstanceOf(Date);
  });

  it('falls through to the next analytics provider on failure', async () => {
    const service = new QuoteService(
      [
        analyticsProvider('first', 10, async () => {
          throw new ProviderUnavailableError('first');
        }),
        analyticsProvider('second', 20, async () => analytics('GME', 'second')),
      ],
      new MemoryCache(),
      options,
    );

    await expect(service.getAnalytics('GME')).resolves.toMatchObject({ source: 'second' });
  });

  it('treats an unknown symbol as authoritative', async () => {
    const service = new QuoteService(
      [
        analyticsProvider('c', 10, async () => {
          throw new ProviderSymbolUnknownError('c', 'NOPE');
        }),
      ],
      new MemoryCache(),
      options,
    );

    await expect(service.getAnalytics('NOPE')).rejects.toBeInstanceOf(SymbolNotFoundError);
  });

  it('throws AllProvidersUnavailableError when no provider can serve analytics', async () => {
    const service = new QuoteService(
      [{ name: 'quotes-only', priority: 1, supportsAnalytics: false, getQuote: noQuotes }],
      new MemoryCache(),
      options,
    );

    await expect(service.getAnalytics('GME')).rejects.toBeInstanceOf(
      AllProvidersUnavailableError,
    );
  });
});
