# Security

## Reporting a vulnerability

Open a private security advisory through the repository's **Security** tab
rather than a public issue. I'll acknowledge within a few days.

## What this service does to protect itself

**Input validation at the edge.** Symbols must match a ticker pattern before
anything else happens. Unvalidated input never reaches a cache key or a URL
built for a vendor, which is what would turn a malformed symbol into cache
poisoning or SSRF.

**No secrets in output.** Vendor keys arrive only through environment
variables. `redactConfig` replaces anything matching `*_KEY`, plus `REDIS_URL`,
before config can be logged. A test asserts the secret does not survive
serialisation.

**No upstream detail in error bodies.** Callers get a generic error code; the
vendor name, URL and stack trace stay in the logs. Which vendor is down is
information about the dependency graph and is of no use to a legitimate client.

**Rate limiting** is applied per client IP, keyed on the forwarded address so a
load balancer does not collapse every client into one bucket.

**Request timeouts** cap any single vendor call, so a hung upstream cannot hold
connections open indefinitely.

**Container hardening.** Multi-stage build with no dev dependencies in the
runtime image, running as the unprivileged `node` user, with
`no-new-privileges` set in compose.

## Automated checks

| Check | Runs |
| --- | --- |
| CodeQL (`security-and-quality`) | every push, PR, and weekly |
| `npm audit --audit-level=high` | every push and PR |
| Trivy image scan (HIGH, CRITICAL) | every push and PR |
| Dependabot (npm, Docker, Actions) | weekly |

## Known limitations

- Single-flight deduplication is per process, so a multi-instance deployment can
  still issue one upstream call per instance for the same symbol.
- There is no authentication on the API itself. It is designed to sit behind a
  gateway that handles authn/authz; exposing it directly to the internet would
  need that added first.
