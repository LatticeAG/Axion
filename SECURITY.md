# Security

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub Security Advisories
("Report a vulnerability" under the repository's Security tab). If that is not
available to you, open a regular GitHub issue but leave out exploit details and
ask a maintainer for a private channel.

We will acknowledge reports and work with you on a fix. There is no bug bounty.

## Read authentication

Every public read API requires `AXION_READ_TOKEN` unless local `AXION_OPEN_READ=true`.

Accepted on all read routes:

- `Authorization: Bearer <token>`
- `x-axion-read-token: <token>`

`GET /api/sse/:id` also accepts `?readToken=` because the browser EventSource API
cannot set request headers. Do not log `url.search` on that handler. If you object
to tokens in URLs, put a network-level proxy in front that injects the header and
strips the query.

Missing or wrong token returns 401 `{ error: { message: "Read authentication required" } }`
with no resource-existence leak. If neither token nor `AXION_OPEN_READ=true` is set,
reads fail closed. Do not set `AXION_OPEN_READ` in production `wrangler.toml` `[vars]`.

Session id is an identifier, not an authorization token. `GET /api/sessions` and
`GET /api/export/all` list every session this Worker has seen, so a shared token
is the access control.

Compare tokens with a timing-safe check. Never log `Authorization`, `x-api-key`,
`AXION_READ_TOKEN`, `AXION_WEBHOOK_SECRET`, or unredacted `rawText`.

## CORS

`Access-Control-Allow-Origin` is reflected only when `AXION_CORS_ORIGIN` is set
and exactly matches the request `Origin`. Otherwise the header is omitted so
browser cross-site reads fail. `OPTIONS /api/*` returns 204 with
`Access-Control-Allow-Methods: GET, OPTIONS` and
`Access-Control-Allow-Headers: Authorization, x-axion-read-token, x-axion-session`.

## Export contents

`GET /api/beliefs/:id` and search results omit model-output `rawText` (empty
string). `GET /api/sessions/:id/export/json` includes `batches[].rawText` only
with `?includeRaw=1`. Markdown export never includes raw source.

## Search cursors

`GET /api/search` signs cursors with server-only `AXION_CURSOR_SECRET`
(`wrangler secret put`). The read token is client-held and must not be the HMAC
key. If the cursor secret is unset, search returns 503.

## Rate limits

Fixed-window limits via the Cache API, 60 second buckets, keyed by token or
client IP:

- 30 `/api/search` per token per minute
- 6 `/api/export/all` per token per minute
- 120 other authenticated reads per token per minute

`GET /api/health` is not limited. Proxy POSTs are not limited here.
429 responses include `Retry-After: 60`. If the Cache API is unavailable,
`/api/search` and `/api/export/all` return 503 rather than a fake isolate-local
counter.

## Secret redaction

Before persistence, `redactSecrets` replaces PEM blocks, `sk-` / `sk-ant-` /
`ghp_` / `github_pat_` prefixes, `Bearer` tokens, AWS `AKIA` keys, and Slack
`xox[baprs]-` tokens with `[REDACTED:<kind>]`. This is not PII completeness.
A UI filter is too late. Public GET still strips `rawText` even if a detector
misses.

## Belief-batch webhook

After a successful store, if `AXION_BELIEF_WEBHOOK_URL` is set, the Worker POSTs
`axion.belief_batch.v1` from `waitUntil`. The body never includes `rawText`.
Sign with `wrangler secret put AXION_WEBHOOK_SECRET`. The header is
`x-axion-signature: sha256=<hex>` over the raw JSON body. If the secret is
unset, Axion refuses to send unless `AXION_WEBHOOK_ALLOW_UNSIGNED=true`.
Do not set the unsigned escape in production.

A down or slow webhook cannot 5xx the proxy. Failures are logged and counted
on session `meta.webhookFailures`. Treat the sink URL as an operator choice;
the payload still contains redacted beliefs and action names.

## Upstream credentials

The proxy forwards the caller's `Authorization` / `x-api-key` upstream, or uses
the `UPSTREAM_API_KEY` secret if configured. It never logs keys and never sends
`Bearer undefined`. Put secrets with `wrangler secret put`, never in `[vars]`.

## SSE query token

The `?readToken=` exception is rate-limited with the other reads. Prefer a
fronting proxy that injects `x-axion-read-token` if your deployment cannot
accept tokens in URLs.
