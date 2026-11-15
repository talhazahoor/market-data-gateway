import { describe, expect, it } from 'vitest';
import { loadConfig, redactConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies defaults when optional values are absent', () => {
    const config = loadConfig({});
    expect(config.PORT).toBe(3000);
    expect(config.QUOTE_TTL_SECONDS).toBe(5);
    // Analytics change far more slowly than prices, so they are cached longer.
    expect(config.ANALYTICS_TTL_SECONDS).toBe(900);
    expect(config.REDIS_URL).toBeUndefined();
  });

  it('coerces numeric environment strings', () => {
    const config = loadConfig({ PORT: '8080', QUOTE_TTL_SECONDS: '30' });
    expect(config.PORT).toBe(8080);
    expect(config.QUOTE_TTL_SECONDS).toBe(30);
  });

  it('fails fast with a readable message on a bad port', () => {
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/PORT/);
  });

  it('rejects a malformed Redis URL rather than discovering it at runtime', () => {
    expect(() => loadConfig({ REDIS_URL: 'not-a-url' })).toThrow(/REDIS_URL/);
  });

  it('rejects a TTL of zero, which would disable caching silently', () => {
    expect(() => loadConfig({ QUOTE_TTL_SECONDS: '0' })).toThrow(/QUOTE_TTL_SECONDS/);
  });

  it('names every invalid field, not just the first', () => {
    const run = () => loadConfig({ PORT: '-1', LOG_LEVEL: 'chatty' });
    expect(run).toThrow(/PORT/);
    expect(run).toThrow(/LOG_LEVEL/);
  });
});

describe('redactConfig', () => {
  it('redacts vendor keys and the Redis URL', () => {
    const config = loadConfig({
      VENDOR_A_KEY: 'sk-live-super-secret',
      REDIS_URL: 'redis://user:password@cache:6379',
    });
    const redacted = redactConfig(config);

    expect(redacted['VENDOR_A_KEY']).toBe('[redacted]');
    expect(redacted['REDIS_URL']).toBe('[redacted]');
    expect(JSON.stringify(redacted)).not.toContain('super-secret');
    expect(JSON.stringify(redacted)).not.toContain('password');
  });

  it('leaves non-sensitive values readable for debugging', () => {
    const redacted = redactConfig(loadConfig({ PORT: '8080' }));
    expect(redacted['PORT']).toBe(8080);
  });
});
