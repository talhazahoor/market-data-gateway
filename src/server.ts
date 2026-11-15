import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import {
  AllProvidersUnavailableError,
  SymbolNotFoundError,
} from './domain/quote.js';
import type { QuoteService } from './quoteService.js';

/**
 * Tickers are 1-5 letters, optionally with a class suffix such as BRK.B.
 * Validating at the edge keeps malformed input out of cache keys and out of
 * URLs we build for vendors.
 */
const symbolSchema = z
  .string()
  .trim()
  .min(1)
  .max(10)
  .regex(/^[A-Za-z]{1,5}(\.[A-Za-z]{1,2})?$/, 'must be a ticker such as AAPL or BRK.B');

const paramsSchema = z.object({ symbol: symbolSchema });

export async function buildServer(
  service: QuoteService,
  config: Config,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    // Trust the proxy so rate limiting keys on the real client IP rather than
    // on the load balancer, which would otherwise share one bucket.
    trustProxy: true,
  });

  // Must be awaited before the routes are declared. Fastify defers plugin
  // loading until ready(), and an onRequest hook only applies to routes
  // registered after it is installed — register without awaiting and every
  // route below silently bypasses the rate limiter.
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
  });

  app.get('/health', async () => ({
    status: 'ok',
    breakers: service.breakerStates(),
  }));

  app.get('/v1/quotes/:symbol', async (request, reply) => {
    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_symbol',
        message: parsed.error.issues[0]?.message ?? 'invalid symbol',
      });
    }
    const quote = await service.getQuote(parsed.data.symbol);
    // Let shared caches reuse the response for the remaining TTL.
    return reply.header('cache-control', 'public, max-age=' + config.QUOTE_TTL_SECONDS).send(quote);
  });

  app.get('/v1/analytics/:symbol', async (request, reply) => {
    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_symbol',
        message: parsed.error.issues[0]?.message ?? 'invalid symbol',
      });
    }
    const analytics = await service.getAnalytics(parsed.data.symbol);
    return reply
      .header('cache-control', 'public, max-age=' + config.ANALYTICS_TTL_SECONDS)
      .send(analytics);
  });

  /**
   * One place decides what a caller sees. Vendor names, stack traces and
   * upstream URLs stay in the logs; the response body stays generic.
   */
  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof SymbolNotFoundError) {
      return reply.code(404).send({ error: 'symbol_not_found', symbol: error.symbol });
    }
    if (error instanceof AllProvidersUnavailableError) {
      request.log.error({ attempted: error.attempted }, 'all providers unavailable');
      return reply
        .code(503)
        .header('retry-after', '30')
        .send({ error: 'upstream_unavailable' });
    }
    if (hasStatusCode(error) && error.statusCode === 429) {
      return reply.code(429).send({ error: 'rate_limited' });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error' });
  });

  return app;
}

/** Fastify surfaces plugin errors (e.g. rate limiting) with a statusCode. */
function hasStatusCode(error: unknown): error is { statusCode: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof (error as { statusCode: unknown }).statusCode === 'number'
  );
}
