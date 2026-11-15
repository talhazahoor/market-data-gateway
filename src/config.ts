import { z } from 'zod';

/**
 * Configuration is validated at startup and nowhere else.
 *
 * A missing or malformed vendor key should stop the process immediately with a
 * readable message, not surface at 3am as a 500 on one code path. Everything
 * downstream can then treat config as known-good.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /** Omit to run with an in-process cache — useful locally and in CI. */
  REDIS_URL: z.string().url().optional(),

  /** Quotes go stale fast; analytics do not. Hence two different TTLs. */
  QUOTE_TTL_SECONDS: z.coerce.number().int().positive().default(5),
  ANALYTICS_TTL_SECONDS: z.coerce.number().int().positive().default(900),

  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  BREAKER_RESET_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),

  VENDOR_A_URL: z.string().url().default('https://vendor-a.example.com'),
  VENDOR_A_KEY: z.string().min(1).default('unset'),
  VENDOR_B_URL: z.string().url().default('https://vendor-b.example.com'),
  VENDOR_B_KEY: z.string().min(1).default('unset'),
  VENDOR_C_URL: z.string().url().default('https://vendor-c.example.com'),
  VENDOR_C_KEY: z.string().min(1).default('unset'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => '  ' + i.path.join('.') + ': ' + i.message)
      .join('\n');
    throw new Error('Invalid configuration:\n' + issues);
  }
  return result.data;
}

/**
 * Vendor keys must never reach a log line or an error response. Anything that
 * serialises config goes through this first.
 */
export function redactConfig(config: Config): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  for (const key of Object.keys(out)) {
    if (key.endsWith('_KEY') || key === 'REDIS_URL') out[key] = '[redacted]';
  }
  return out;
}
