import { describe, expect, it, vi } from 'vitest';
import { MemoryCache, quoteKey } from '../src/cache/cache.js';
import { SymbolNotFoundError, type Quote } from '../src/domain/quote.js';
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

function quote(symbol: string, source: string, price = 100): Quote {
  return {
    symbol,
    price,
    change: 1,
    changePercent: 1,
    currency: 'USD',
    asOf: new Date('2026-01-01T00:00:00.000Z'),
    source,
  };
}

/** Minimal stub provider; behaviour is supplied per test. */
function stub(
  name: string,
  priority: number,
  getQuote: MarketDataProvider['getQuote'],
): MarketDataProvider {
  return { name, priority, supportsAnalytics: false, getQuote };
}

describe('QuoteService', () => {
  it('returns the highest-priority provider that succeeds', async () => {
    const service = new QuoteService(
      [
        stub('slow-but-second', 20, async () => quote('AAPL', 'slow-but-second')),
        stub('preferred', 10, async () => quote('AAPL', 'preferred')),
      ],
      new MemoryCache(),
      options,
    );

    const result = await service.getQuote('aapl');
    expect(result.source).toBe('preferred');
  });

  it('falls through to the next provider when the first is unavailable', async () => {
    const first = vi.fn(async () => {
      throw new ProviderUnavailableError('a');
    });
    const service = new QuoteService(
      [stub('a', 10, first), stub('b', 20, async () => quote('AAPL', 'b'))],
      new MemoryCache(),
      options,
    );

    const result = await service.getQuote('AAPL');
    expect(result.source).toBe('b');
    expect(first).toHaveBeenCalledOnce();
  });

  it('serves a second identical request from cache without calling a provider', async () => {
    const provider = vi.fn(async () => quote('AAPL', 'a'));
    const service = new QuoteService([stub('a', 10, provider)], new MemoryCache(), options);

    await service.getQuote('AAPL');
    await service.getQuote('AAPL');
    expect(provider).toHaveBeenCalledOnce();
  });

  it('revives asOf as a Date when the value comes back from cache', async () => {
    const cache = new MemoryCache();
    // Simulate what JSON round-tripping through Redis actually stores.
    const serialised = JSON.parse(JSON.stringify(quote('AAPL', 'a'))) as Quote;
    await cache.set(quoteKey('AAPL'), serialised, 60);

    const service = new QuoteService([], cache, options);
    const result = await service.getQuote('AAPL');
    expect(result.asOf).toBeInstanceOf(Date);
    expect(result.asOf.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('collapses concurrent identical misses into one upstream call', async () => {
    let calls = 0;
    const provider = stub('a', 10, async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return quote('AAPL', 'a');
    });
    const service = new QuoteService([provider], new MemoryCache(), options);

    const results = await Promise.all([
      service.getQuote('AAPL'),
      service.getQuote('AAPL'),
      service.getQuote('AAPL'),
    ]);

    expect(calls).toBe(1);
    expect(results.every((r) => r.source === 'a')).toBe(true);
  });

  it('treats an unknown symbol as authoritative and does not try other providers', async () => {
    const second = vi.fn(async () => quote('NOPE', 'b'));
    const service = new QuoteService(
      [
        stub('a', 10, async () => {
          throw new ProviderSymbolUnknownError('a', 'NOPE');
        }),
        stub('b', 20, second),
      ],
      new MemoryCache(),
      options,
    );

    await expect(service.getQuote('NOPE')).rejects.toBeInstanceOf(SymbolNotFoundError);
    expect(second).not.toHaveBeenCalled();
  });

  it('throws AllProvidersUnavailableError listing everything it tried', async () => {
    const down = async (): Promise<Quote> => {
      throw new ProviderUnavailableError('down');
    };
    const service = new QuoteService(
      [stub('a', 10, down), stub('b', 20, down)],
      new MemoryCache(),
      options,
    );

    await expect(service.getQuote('AAPL')).rejects.toMatchObject({
      name: 'AllProvidersUnavailableError',
      attempted: ['a', 'b'],
    });
  });

  it('stops calling a provider once its breaker opens', async () => {
    const flaky = vi.fn(async (): Promise<Quote> => {
      throw new ProviderUnavailableError('a');
    });
    const service = new QuoteService(
      [stub('a', 10, flaky), stub('b', 20, async () => quote('AAPL', 'b'))],
      new MemoryCache(),
      options,
    );

    // failureThreshold is 2, and each lookup uses a distinct symbol to avoid
    // the cache so that the provider is genuinely re-attempted each time.
    await service.getQuote('AAA');
    await service.getQuote('BBB');
    expect(service.breakerStates()['a']).toBe('open');

    const callsBefore = flaky.mock.calls.length;
    const result = await service.getQuote('CCC');
    expect(result.source).toBe('b');
    expect(flaky.mock.calls.length).toBe(callsBefore);
  });

  it('aborts a provider that exceeds the timeout and uses the fallback', async () => {
    const hang = stub('slow', 10, (_symbol, signal) =>
      new Promise<Quote>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new ProviderUnavailableError('slow')));
      }),
    );
    const service = new QuoteService(
      [hang, stub('fast', 20, async () => quote('AAPL', 'fast'))],
      new MemoryCache(),
      options,
    );

    const result = await service.getQuote('AAPL');
    expect(result.source).toBe('fast');
  });
});
