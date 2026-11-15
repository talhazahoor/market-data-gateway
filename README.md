# market-data-gateway

A read-through gateway that puts several equity market-data vendors behind one
API, so the rest of a system never learns which vendor answered.

Built because the alternative — every service calling every vendor directly —
means each one reimplements normalisation, caching, retry and failover, and
every vendor change touches a dozen codebases.

```
GET /v1/quotes/AAPL
{
  "symbol": "AAPL",
  "price": 185.5,
  "change": -2.5,
  "changePercent": -1.33,
  "currency": "USD",
  "asOf": "2026-01-01T00:00:00.000Z",
  "source": "vendor-a"
}
```

---

## The problems this solves

**Vendors disagree about everything.** One sends prices in cents, another in
dollars. One uses epoch seconds, another ISO strings. One calls the field
`ticker`, another `symbol`. Each provider owns its own normalisation and emits
the same canonical `Quote`, so nothing downstream carries vendor-shaped code.

**Vendor calls cost money and are rate-limited.** Quotes are cached in Redis for
a few seconds; short-interest and sentiment, which barely move intraday, are
cached for fifteen minutes. Concurrent identical misses are collapsed into one
upstream call, so a hundred simultaneous requests for `AAPL` buy one quote
rather than a hundred.

**Vendors fail, and they fail slowly.** Each provider sits behind its own
circuit breaker. After a threshold of consecutive failures the gateway stops
calling it entirely for a cooldown, then lets a single probe through. A failing
vendor costs one request, not every request.

**"No such symbol" is not an outage.** A vendor answering *I don't have that
ticker* has answered correctly. That returns 404 immediately, does not count
against the vendor's health, and does not waste a paid call asking the others
the same question.

---

## Architecture

```
          HTTP  ──►  validate symbol  ──►  rate limit
                                              │
                                              ▼
                                        QuoteService
                                              │
                      ┌───────────────────────┼───────────────────────┐
                      ▼                       ▼                       ▼
                 Redis cache          single-flight map        provider chain
               (fails open)         (dedupes misses)          (priority order)
                                                                      │
                                               ┌──────────────────────┼─────────┐
                                               ▼                      ▼         ▼
                                         breaker+timeout        breaker     breaker
                                           vendor-a             vendor-b    vendor-c
```

| Layer | File | Responsibility |
| --- | --- | --- |
| HTTP | `src/server.ts` | Validation, rate limiting, error mapping |
| Orchestration | `src/quoteService.ts` | Cache-aside, single-flight, failover |
| Resilience | `src/resilience/circuitBreaker.ts` | Three-state breaker |
| Caching | `src/cache/cache.ts` | Redis and in-memory, versioned keys |
| Vendors | `src/providers/vendors.ts` | Transport plus normalisation |
| Domain | `src/domain/quote.ts` | Canonical types |
| Config | `src/config.ts` | Startup validation, secret redaction |

---

## Decisions and trade-offs

**The cache fails open.** If Redis is unreachable, `get` returns null and the
request proceeds to a vendor. A cache outage should cost latency and vendor
spend, never availability. The cost is that a Redis outage during a traffic
spike passes that spike straight to the vendors — acceptable, because the
breakers then protect the vendors.

**Breakers are per vendor, not global.** One vendor having a bad afternoon
should not stop the others being tried.

**Cache keys carry a schema version** (`mdg:v1:quote:AAPL`). When the shape of
`Quote` changes, bumping the version invalidates every old entry at once rather
than deserialising yesterday's shape into today's type.

**Errors are mapped in one place.** Vendor names, upstream URLs and stack traces
go to the logs; callers get `{ "error": "upstream_unavailable" }`. Leaking which
vendor is down tells an attacker about the dependency graph, and tells ordinary
clients something they cannot act on.

**Config is validated once, at startup.** A missing vendor key kills the process
with a readable message instead of surfacing at 3am as a 500 on one code path.

**Single-flight is per process.** Two instances can still issue two calls for the
same symbol. A distributed lock would fix that and would add a Redis round-trip
to the hot path plus a new failure mode; at two or three instances the maths
does not justify it. At thirty it would.

---

## Running it

```bash
cp .env.example .env     # fill in vendor keys, or leave the defaults to run offline
npm install
npm run dev
```

Without `REDIS_URL` the service uses an in-process cache, which is enough for
local work and CI. With Docker:

```bash
docker compose up --build
curl localhost:3000/health
```

`/health` reports the live breaker state per vendor, which is the first thing
worth looking at when latency climbs:

```json
{ "status": "ok", "breakers": { "vendor-a": "closed", "vendor-b": "open" } }
```

---

## Tests

```bash
npm test              # 57 tests
npm run test:coverage # thresholds enforced: 85% statements, 80% branches
```

The suite covers the behaviour that matters rather than chasing a number: the
breaker's full state machine including the half-open single-probe guard, cache
expiry and fail-open, every vendor's normalisation including the divide-by-zero
on a missing previous close, single-flight deduplication, provider failover,
timeout abort, and the HTTP contract end to end.

One of these found a real bug. The rate-limit test failed on first run because
`app.register()` was not awaited — Fastify defers plugin loading, and an
`onRequest` hook only applies to routes declared after it is installed, so every
route was quietly bypassing the limiter. It looked correct and the service
worked; only the test showed the limiter was never attached. See the comment in
`src/server.ts`.

## CI and security

- **CI** — typecheck, lint, tests with enforced coverage, `npm audit`, Docker
  build, Trivy image scan, and a smoke test that boots the container and waits
  for `/health`.
- **CodeQL** — `security-and-quality` queries on every push and weekly.
- **Dependabot** — npm, Docker and Actions, with patch and minor grouped.
- **Image** — multi-stage, no dev dependencies in the final layer, runs as the
  unprivileged `node` user, `no-new-privileges`, exec-form `CMD` so `SIGTERM`
  reaches the process and the graceful shutdown runs.
- **Secrets** — vendor keys only ever arrive via environment. `redactConfig`
  strips anything matching `*_KEY` and `REDIS_URL` before config is logged, and
  there is a test asserting the secret does not survive serialisation.

## Licence

MIT.
