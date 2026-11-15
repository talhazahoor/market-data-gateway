import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { MemoryCache } from '../src/cache/cache.js';
import { loadConfig } from '../src/config.js';
import type { Quote } from '../src/domain/quote.js';
import {
  ProviderSymbolUnknownError,
  ProviderUnavailableError,
  type MarketDataProvider,
} from '../src/providers/types.js';
import { QuoteService } from '../src/quoteService.js';
import { buildServer } from '../src/server.js';

const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal', RATE_LIMIT_MAX: '3' });

function serviceWith(getQuote: MarketDataProvider['getQuote']): QuoteService {
  return new QuoteService(
    [{ name: 'stub', priority: 10, supportsAnalytics: false, getQuote }],
    new MemoryCache(),
    {
      quoteTtlSeconds: 5,
      analyticsTtlSeconds: 60,
      providerTimeoutMs: 50,
      breaker: { failureThreshold: 5, resetTimeoutMs: 1000 },
    },
  );
}

const ok: MarketDataProvider['getQuote'] = async (symbol): Promise<Quote> => ({
  symbol,
  price: 185.5,
  change: -2.5,
  changePercent: -1.33,
  currency: 'USD',
  asOf: new Date('2026-01-01T00:00:00.000Z'),
  source: 'stub',
});

describe('HTTP API', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it('returns a normalised quote with a cache-control header', async () => {
    app = await buildServer(serviceWith(ok), config);
    const res = await app.inject({ method: 'GET', url: '/v1/quotes/AAPL' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=5');
    expect(res.json()).toMatchObject({ symbol: 'AAPL', price: 185.5, source: 'stub' });
  });

  it('rejects a malformed ticker before any vendor is called', async () => {
    let called = false;
    app = await buildServer(
      serviceWith(async (s) => {
        called = true;
        return ok(s, new AbortController().signal);
      }),
      config,
    );

    const res = await app.inject({ method: 'GET', url: '/v1/quotes/not-a-ticker!' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_symbol');
    expect(called).toBe(false);
  });

  it('accepts class-suffixed tickers such as BRK.B', async () => {
    app = await buildServer(serviceWith(ok), config);
    const res = await app.inject({ method: 'GET', url: '/v1/quotes/BRK.B' });
    expect(res.statusCode).toBe(200);
  });

  it('maps an unknown symbol to 404', async () => {
    app = await buildServer(
      serviceWith(async () => {
        throw new ProviderSymbolUnknownError('stub', 'NOPE');
      }),
      config,
    );

    const res = await app.inject({ method: 'GET', url: '/v1/quotes/NOPE' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'symbol_not_found', symbol: 'NOPE' });
  });

  it('maps a total upstream outage to 503 with retry-after, leaking no vendor detail', async () => {
    app = await buildServer(
      serviceWith(async () => {
        throw new ProviderUnavailableError('stub');
      }),
      config,
    );

    const res = await app.inject({ method: 'GET', url: '/v1/quotes/AAPL' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('30');
    expect(res.json()).toEqual({ error: 'upstream_unavailable' });
    expect(res.body).not.toContain('stub');
  });

  it('reports breaker state on /health', async () => {
    app = await buildServer(serviceWith(ok), config);
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', breakers: { stub: 'closed' } });
  });

  it('rate limits once the window budget is spent', async () => {
    app = await buildServer(serviceWith(ok), config);
    await app.ready();

    const codes: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/quotes/AAPL',
        remoteAddress: '203.0.113.9',
      });
      codes.push(res.statusCode);
    }

    // RATE_LIMIT_MAX is 3 for this suite.
    expect(codes.filter((c) => c === 200)).toHaveLength(3);
    expect(codes.filter((c) => c === 429)).toHaveLength(2);
  });
});
