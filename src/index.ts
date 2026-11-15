import { Redis } from 'ioredis';
import { loadConfig } from './config.js';
import { MemoryCache, RedisCache, type Cache } from './cache/cache.js';
import { QuoteService } from './quoteService.js';
import { buildServer } from './server.js';
import { createHttpGet, VendorAProvider, VendorBProvider, VendorCProvider } from './providers/vendors.js';

async function main(): Promise<void> {
  const config = loadConfig();

  let cache: Cache;
  if (config.REDIS_URL) {
    const redis = new Redis(config.REDIS_URL, {
      // Fail fast rather than queueing commands while Redis is down — the
      // cache is optional, so a hung command is worse than a miss.
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: false,
    });
    redis.on('error', (err) => console.error({ err: err.message }, 'redis error'));
    cache = new RedisCache(redis, (err) => console.error({ err }, 'cache operation failed'));
  } else {
    cache = new MemoryCache();
  }

  const providers = [
    new VendorAProvider(createHttpGet('X-Api-Key', config.VENDOR_A_KEY), config.VENDOR_A_URL),
    new VendorBProvider(createHttpGet('Authorization', config.VENDOR_B_KEY), config.VENDOR_B_URL),
    new VendorCProvider(createHttpGet('X-Api-Key', config.VENDOR_C_KEY), config.VENDOR_C_URL),
  ];

  const service = new QuoteService(providers, cache, {
    quoteTtlSeconds: config.QUOTE_TTL_SECONDS,
    analyticsTtlSeconds: config.ANALYTICS_TTL_SECONDS,
    providerTimeoutMs: config.PROVIDER_TIMEOUT_MS,
    breaker: {
      failureThreshold: config.BREAKER_FAILURE_THRESHOLD,
      resetTimeoutMs: config.BREAKER_RESET_TIMEOUT_MS,
    },
  });

  const app = await buildServer(service, config);

  // Give in-flight requests a chance to finish before the process exits,
  // otherwise a rolling deploy returns 502s to whoever was mid-request.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      app.log.info({ signal }, 'shutting down');
      void app
        .close()
        .then(() => cache.close())
        .then(() => process.exit(0));
    });
  }

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
