import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import {
  analyticsKey,
  MemoryCache,
  quoteKey,
  RedisCache,
} from '../src/cache/cache.js';

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

/** Enough of the ioredis surface for these tests, without a live server. */
function fakeRedis(overrides: Partial<Redis> = {}): Redis {
  return {
    get: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
    quit: vi.fn(async () => 'OK'),
    ...overrides,
  } as unknown as Redis;
}

describe('cache keys', () => {
  it('uppercases the symbol so aapl and AAPL share one entry', () => {
    expect(quoteKey('aapl')).toBe(quoteKey('AAPL'));
  });

  it('keeps quote and analytics entries in separate namespaces', () => {
    expect(quoteKey('AAPL')).not.toBe(analyticsKey('AAPL'));
  });

  it('carries a schema version so a shape change invalidates old entries', () => {
    expect(quoteKey('AAPL')).toContain(':v1:');
  });
});

describe('MemoryCache', () => {
  it('returns a stored value before it expires', async () => {
    const cache = new MemoryCache();
    await cache.set('k', { a: 1 }, 60);
    expect(await cache.get<{ a: number }>('k')).toEqual({ a: 1 });
  });

  it('returns null once the TTL has elapsed', async () => {
    const c = clock();
    const cache = new MemoryCache(c.now);
    await cache.set('k', 'v', 10);

    c.advance(9_999);
    expect(await cache.get('k')).toBe('v');

    c.advance(1);
    expect(await cache.get('k')).toBeNull();
  });

  it('returns null for a key that was never set', async () => {
    expect(await new MemoryCache().get('absent')).toBeNull();
  });
});

describe('RedisCache', () => {
  it('round-trips a value through JSON', async () => {
    const store = new Map<string, string>();
    const redis = fakeRedis({
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => {
        store.set(k, v);
        return 'OK';
      }),
    } as Partial<Redis>);

    const cache = new RedisCache(redis);
    await cache.set('k', { price: 1.5 }, 30);
    expect(await cache.get<{ price: number }>('k')).toEqual({ price: 1.5 });
  });

  it('sets a TTL rather than writing an entry that never expires', async () => {
    const redis = fakeRedis();
    await new RedisCache(redis).set('k', 'v', 42);
    expect(redis.set).toHaveBeenCalledWith('k', '"v"', 'EX', 42);
  });

  it('fails open on a read error: a cache outage is a miss, not a 500', async () => {
    const onError = vi.fn();
    const redis = fakeRedis({
      get: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    } as Partial<Redis>);

    await expect(new RedisCache(redis, onError).get('k')).resolves.toBeNull();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('fails open on a write error', async () => {
    const onError = vi.fn();
    const redis = fakeRedis({
      set: vi.fn(async () => {
        throw new Error('READONLY');
      }),
    } as Partial<Redis>);

    await expect(new RedisCache(redis, onError).set('k', 'v', 10)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('swallows errors while closing, so shutdown cannot hang', async () => {
    const redis = fakeRedis({
      quit: vi.fn(async () => {
        throw new Error('already closed');
      }),
    } as Partial<Redis>);

    await expect(new RedisCache(redis).close()).resolves.toBeUndefined();
  });
});
