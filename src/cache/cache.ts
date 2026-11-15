import type { Redis } from 'ioredis';

/**
 * Cache abstraction.
 *
 * The service depends on this interface rather than on ioredis directly, which
 * keeps Redis out of the unit tests and means a future move to a different
 * store is a one-file change.
 */
export interface Cache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  /** Best-effort; never throws. Used on shutdown. */
  close(): Promise<void>;
}

/** Used in tests and as a fallback when Redis is not configured. */
export class MemoryCache implements Cache {
  private readonly store = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async get<T>(key: string): Promise<T | null> {
    const hit = this.store.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= this.now()) {
      this.store.delete(key);
      return null;
    }
    return hit.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  async close(): Promise<void> {
    this.store.clear();
  }
}

/**
 * Redis-backed cache.
 *
 * Deliberately fail-open: if Redis is down, a cache miss is the right outcome,
 * not a 500. An outage in the cache should degrade latency and vendor spend,
 * never availability.
 */
export class RedisCache implements Cache {
  constructor(
    private readonly redis: Redis,
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(key);
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch (error) {
      this.onError(error);
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (error) {
      this.onError(error);
    }
  }

  async close(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      // Shutting down; nothing useful to do with this.
    }
  }
}

/**
 * Cache keys carry a schema version. When the shape of a cached object changes,
 * bumping this invalidates every old entry instead of deserialising stale data
 * into a type that no longer matches it.
 */
const SCHEMA_VERSION = 'v1';

export function quoteKey(symbol: string): string {
  return 'mdg:' + SCHEMA_VERSION + ':quote:' + symbol.toUpperCase();
}

export function analyticsKey(symbol: string): string {
  return 'mdg:' + SCHEMA_VERSION + ':analytics:' + symbol.toUpperCase();
}
