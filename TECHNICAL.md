# Axion technical reference

> How the Worker actually behaves, matched to the code in `src/`.
> High-level overview: [README.md](./README.md). Locked scope: [BUILD-SPEC.md](./BUILD-SPEC.md).
> **Full normative specification: [SPEC.md](./SPEC.md).** This file is a code-oriented companion; where the two differ, SPEC.md wins.

This document describes what is implemented. Planned layers (Loop, Gate, belief graph, semantic PolyVerdict) are called out as planned and have no runtime.

---

## Request routing

The Worker entry point is `src/proxy/index.ts`. It routes on method and pathname:

| Method + path | Handler | Result |
|---|---|---|
| `GET /api/beliefs/:sessionId` | `fetchBeliefs` | flat belief timeline for a session |
| `GET /dashboard`, `/dashboard/*` | `handleDashboard` | dashboard static assets |
| `POST /v1/chat/completions` | OpenAI adapter | proxy (observe or enforce) |
| `POST /v1/messages` | Anthropic adapter | proxy (observe or enforce) |
| `GET /` | redirect | 302 to `/dashboard` |
| anything else | fallthrough | 404 |

There is no `/api/sessions` route. Session discovery is by pasting an id into the dashboard, not by listing.

Provider matching lives in `src/proxy/providers/index.ts`. `matchProvider(pathname, method)` walks the adapter list and returns the first adapter whose `match()` claims the request, or null.

---

## Auth (`src/proxy/auth.ts`)

`resolveUpstreamHeaders(request, env, provider)` builds the upstream headers or returns a ready-to-send 401. It follows the passthrough-first model (BUILD-SPEC D1), in this order:

1. Caller `Authorization` header present: forward it as-is. This also covers gateway tokens.
2. Else caller `x-api-key` present: forward it (Anthropic-style key).
3. Else `env.UPSTREAM_API_KEY` set and non-empty after trim: use the server key. On the Anthropic path it is sent as `x-api-key`; otherwise as `Authorization: Bearer <key>`.
4. Else: return 401 with `{ "error": { "message": "Provide Authorization or x-api-key, or configure UPSTREAM_API_KEY" } }`.

The server key is only used when it trims to a non-empty string, so `Bearer undefined` is never emitted. `OpenAI-Organization` is forwarded when present. On the Anthropic path, `anthropic-version` is set from the caller header or defaults to `2023-06-01`.

The result is a discriminated union: `{ ok: true, headers }` or `{ ok: false, response }`. The proxy branches on `ok` rather than catching exceptions.

---

## Observe path (default)

For a request with no schema trigger, `observeProviderRequest` in `index.ts` runs:

1. Read the session id from `x-axion-session`, or generate a UUID.
2. Parse and validate the JSON body via the provider adapter (non-empty `messages[]`).
3. Resolve upstream headers (auth above).
4. `fetch` the upstream URL (`UPSTREAM_API_URL` + the adapter's `upstreamPath`) with the original raw body.
5. If upstream is not OK, pass the response through unchanged (with the session header added).
6. Tee the response body with `teeResponseForExtraction` (`src/proxy/stream.ts`). One branch streams to the caller untouched. The other accumulates assistant text.
7. In `ctx.waitUntil`, await the accumulated text, normalize it, run `extractBeliefs({ sessionId })`, and store the result in the Durable Object.
8. Return the caller branch with an `x-axion-session` response header.

The agent never waits for extraction. The only synchronous cost is forwarding the request and the tee, which does not buffer the caller branch.

### Streaming vs non-streaming

`isSse` is true when the request body had `stream: true` or the upstream `content-type` includes `text/event-stream`.

- **SSE:** the extraction branch parses `data:` records and pulls delta text per provider. OpenAI deltas come from `choices[0].delta.content`; Anthropic text comes from `content_block_delta` events with `delta.type === "text_delta"`.
- **Non-SSE:** the extraction branch accumulates the raw body, and `extractAssistantText` parses it via the provider adapter. Raw JSON is never fed to the lens.

### Tee and decoding (`src/proxy/stream.ts`)

`teeResponseForExtraction(response, isSse, provider)` calls `response.body.tee()`. The extraction reader decodes with `decoder.decode(value, { stream: true })` on each chunk and a final `decoder.decode()` flush to release any bytes held mid multi-byte sequence. For SSE, an `SseLineParser` splits on the blank-line record delimiter (tolerating `\n\n` and `\r\n\r\n`), joins `data:` lines per the SSE spec, and a `flush()` handles a trailing record with no terminator. Accumulation is best-effort: a read error is swallowed so extraction never breaks the proxy.

---

## Content normalization (`src/proxy/content.ts`)

`extractAssistantText({ provider, isSse, accumulated })` returns the assistant text for extraction:

- SSE: `accumulated` already holds the joined delta text from the tee, so it is returned trimmed.
- Non-SSE OpenAI: `choices[0].message.content`, either a string or an array of text parts, joined.
- Non-SSE Anthropic: every `content[]` block with `type === "text"`, joined.

All extractors are defensive. A malformed body yields `""` rather than throwing.

---

## Provider adapters (`src/proxy/providers/`)

`ProviderAdapter` (in `providers/types.ts`) defines the seam:

```typescript
interface ProviderAdapter {
  id: "openai" | "anthropic";
  match(pathname: string, method: string): boolean;
  upstreamPath: string;
  validateRequest(body: unknown): ValidationResult;
  extractAssistantText(rawBody: string): string;
}
```

- `openaiAdapter`: matches `POST /v1/chat/completions`, upstream path `/v1/chat/completions`.
- `anthropicAdapter`: matches `POST /v1/messages`, upstream path `/v1/messages`.

Both validate that `messages` is a non-empty array and delegate non-stream text extraction to the shared `content.ts` helpers.

---

## Session state (`src/state/SessionDurableObject.ts`)

Phase 1 stores beliefs as an append-only chronological timeline, not a graph. There is no in-memory `Map`, no parent/child edges, and no root-cause route.

The DO handles two internal routes:

- `POST /store-beliefs`: appends one batch (`{ beliefs, rawText, timestamp }`) to the `"beliefs"` storage key and refreshes the `"sessionName"` key with the human session id.
- `GET /beliefs`: reads all batches, flattens them into one ordered `ExtractedBelief[]`, and returns `{ sessionId, beliefs }`. The `sessionId` is the stored human name (or the request hint), never the opaque Durable Object id.

Flattening and id resolution are pure functions in `src/state/sessionBeliefs.ts` (`flattenBeliefBatches`, `resolveSessionId`), which keeps them unit-testable and tolerant of corrupt reads.

`GET /api/beliefs/:sessionId` (`src/proxy/beliefs.ts`) resolves the DO by `idFromName(sessionId)`, fetches `/beliefs` with the path id as a hint, and passes the JSON through with permissive CORS headers.

Because beliefs live in Durable Object storage, they survive DO eviction. The real risk is unbounded growth: nothing trims old batches.

---

## Lens patterns and confidence (`src/lens/`)

### Patterns (`patterns.ts`)

`BELIEF_PATTERNS` is an ordered list. Each entry is `{ label, type, pattern, group, evidenceGroup?, actionGroup?, confidence }`. The engine walks patterns in order and the first match wins a span.

- Causal: `because of X`, `because X` (split so group 1 always holds the text), `since X` (non-temporal), `due to X`, `as a result of X`.
- Assumption: `assuming X`, `presumably X`, `I'll assume X`, `if X then Y` (X as belief, Y as action).
- Intention: `I'll X`, `I'm going to X`, `let me X`, `I should X`, `I plan/intend to X`.
- Evidence: `based on X`, `according to X`, `from the X`, `the error says X`. Evidence patterns set `evidenceGroup: 1`, so the cited text lands in both the `belief` and `evidence` fields.

Clause ends at `. ; ! ?` a newline, or end of string, so a match at the very end of a response is not dropped for lack of trailing punctuation.

### Confidence (`extract.ts` + `patterns.ts`)

Confidence starts at the pattern baseline. `CONFIDENCE_MARKERS` are scanned in a window of `MARKER_SCAN_RADIUS` (80) characters on each side of the match. Each marker category found adds its delta:

| Marker category | Words | Delta |
|---|---|---|
| certain | definitely, certainly, absolutely, without a doubt, guaranteed | +0.2 |
| likely | probably, likely, most likely, almost certainly, highly likely | +0.1 |
| possible | might, could be, possibly, may, perhaps | -0.2 |
| uncertain | not sure, uncertain, unsure, unclear | -0.3 |

The sum is added to the baseline and clamped to `[0.1, 1.0]` (`CONFIDENCE_MIN`, `CONFIDENCE_MAX`). This is additive, not midpoint-band interpolation. `DEFAULT_CONFIDENCE` is 0.7.

### Extraction pipeline

```
extractBeliefs(text, { sessionId, uuid?, now? }): Promise<ExtractedBelief[]>

1. Empty / whitespace text -> [].
2. scanPatterns: run every pattern globally, collect matches with capture,
   evidence, action, source index, and line number.
3. Sort by source position, then pattern precedence.
4. dedupeOverlaps: drop a match whose span is wholly inside an earlier one.
5. For each survivor: baseline confidence, adjust by markers in context, clamp.
6. Shape into ExtractedBelief with a UUID and a shared timestamp.
```

Every belief is stamped with the passed `sessionId`. There is no parent linking and no DAG construction.

---

## Types (`src/lens/types.ts`)

`ExtractedBelief` is the record the whole system agrees on:

```typescript
interface ExtractedBelief {
  id: string;
  sessionId: string;
  type: 'causal' | 'assumption' | 'intention' | 'evidence';
  belief: string;
  evidence?: string;
  confidence: number;   // clamped to [0.1, 1.0]
  actionTaken?: string;
  timestamp: number;    // Unix ms
  rawText: string;
  line: number;
}
```

`BeliefNode` (adds `parentIds`, `childIds`, `invalidated?`), `BeliefEdge`, and `BeliefDAG` also exist in this file. They are **planned types only** (BUILD-SPEC D2). No code constructs, stores, or serves them. Do not read their presence as a shipped graph.

---

## PolyVerdict enforce path (`src/polyverdict/`)

Enforce mode is opt-in. `detectSchemaTrigger(headers, body)` returns a trigger when either:

- `x-axion-schema` header holds a JSON Schema (parsed directly, then with `decodeURIComponent` as a fallback), or
- the body has `response_format: { type: "json_schema", json_schema: { schema, name? } }`.

The header takes precedence. When there is no trigger, the request never enters this path.

When triggered, `enforceProviderRequest` in `index.ts` runs a loop up to `MAX_ENFORCE_ATTEMPTS` (3):

1. Force `stream: false` on the upstream body and strip the client `response_format` (the Worker owns validation).
2. `fetch` upstream and extract assistant text via the provider adapter.
3. `enforceOnce(text, schema)`: strip Markdown fences, `parseJsonFromAssistant`, then `validateAndCoerce`.
4. On success, run Lens on the delivered text in `waitUntil` and return a provider-shaped 200 (OpenAI `chat.completion` or Anthropic `message`) whose assistant content is the coerced JSON string.
5. On failure with attempts left, append the violations as a correction message (`buildRetryMessages` / `buildRetryMessagesAnthropic`) and retry.
6. After 3 failures, run Lens on the last text and return HTTP 422 with `{ error: { message, errors, attempts } }`.

Enforce always returns non-streaming JSON, even if the client asked to stream, so the full payload can be validated.

### Schema subset (`schema.ts`)

`validateAndCoerce(data, schema)` implements a minimal JSON Schema subset with zero dependencies:

- Keywords: `type` (single or union), `properties`, `required`, `items` (single schema or tuple), `enum`, and nesting. Unknown keywords are ignored.
- Coercion: `"42"` to number/integer, `"true"`/`"false"` to boolean, finite number/boolean to string. Coercion runs before enum checks so `"42"` can still match an enum of `42`.
- Returns `{ ok: true, value }` (coerced) or `{ ok: false, errors }` (path-keyed messages).

There is no semantic verification, no second model, and no schema registry. Those are future work (see [SPEC-PolyVerdict.md](./SPEC-PolyVerdict.md)).

`enforce.ts` also exports `runEnforceLoop`, a transport-agnostic driver that takes an injected upstream callback. The Worker uses its own inline loop; `runEnforceLoop` exists for tests and reuse.

---

## Latency

| Stage | Observe path | Enforce path |
|---|---|---|
| Request forwarding | one upstream round trip | one upstream round trip per attempt |
| Response to caller | streamed as it arrives, no buffering | buffered, returned after validation |
| Belief extraction | `waitUntil`, after delivery | `waitUntil`, after delivery |
| Added latency | effectively none | validation plus up to 2 retries |

The zero-added-latency claim applies to the observe path only. Enforce mode buffers by design.

---

## Dashboard (`src/dashboard/`)

A single-page React app loaded from CDN via `<script>` tags. No build step, no JSX (`React.createElement`), no bundler, hand-written CSS. Served as static assets through the `ASSETS` binding.

- Session UX: a text input plus Load button. The id prefills from `?session=` in the URL, else from `localStorage` key `axion.sessionId`, and persists to `localStorage` on load.
- It calls `GET /api/beliefs/:sessionId` and reads `data.beliefs`.
- Filters: type, minimum confidence, and a "Low confidence only" toggle (`confidence < 0.4`). There is no "wrong" filter; nothing claims invalidation.
- `BeliefCard` guards `typeof belief.confidence === 'number'` before rendering the confidence bar.

---

## API reference

| Endpoint | Method | Returns |
|---|---|---|
| `/v1/chat/completions` | POST | OpenAI-shaped model response (proxy; enforce returns non-stream JSON) |
| `/v1/messages` | POST | Anthropic-shaped model response (proxy; enforce returns non-stream JSON) |
| `/api/beliefs/:sessionId` | GET | `{ sessionId: string, beliefs: ExtractedBelief[] }` |
| `/dashboard`, `/dashboard/*` | GET | dashboard HTML and static assets |

Request headers the proxy reads: `Authorization`, `x-api-key`, `anthropic-version`, `OpenAI-Organization`, `x-axion-session`, `x-axion-schema`. Every proxied response carries `x-axion-session`.

---

## Configuration

### wrangler.toml

```toml
name = "axion"
main = "src/proxy/index.ts"
compatibility_date = "2024-06-01"
compatibility_flags = ["nodejs_compat"]

[[durable_objects.bindings]]
name = "SESSION"
class_name = "SessionDurableObject"

[[migrations]]
tag = "v1"
new_classes = ["SessionDurableObject"]

[assets]
directory = "./src/dashboard"
binding = "ASSETS"

[vars]
UPSTREAM_API_URL = "https://api.openai.com"
```

### Environment / bindings

| Name | Required | Default | Description |
|---|---|---|---|
| `UPSTREAM_API_URL` | no | `https://api.openai.com` | upstream base URL; the adapter path is appended |
| `UPSTREAM_API_KEY` | no | none | server-side key used only when the caller sends none |
| `SESSION` | yes | - | Durable Object namespace for per-session state |
| `ASSETS` | yes | - | static asset binding for the dashboard |

Set `UPSTREAM_API_KEY` with `wrangler secret put UPSTREAM_API_KEY`, or in `.dev.vars` for local runs (see `.dev.vars.example`).

---

## Tests

Vitest. `npm test` runs the suite; `npm run check` runs `tsc --noEmit` then the suite. CI (`.github/workflows/ci.yml`) runs `npm run check` on Node 20 for pushes to `main` and all PRs.

| File | Covers |
|---|---|
| `src/proxy/auth.test.ts` | passthrough, server key, neither to 401, no `Bearer undefined` |
| `src/proxy/content.test.ts` | OpenAI + Anthropic non-stream and SSE text extraction |
| `src/proxy/stream.test.ts` | SSE parsing and tee accumulation |
| `src/lens/extract.test.ts` | because / because of, sessionId stamp, confidence clamp, evidence field |
| `src/state/SessionDurableObject.test.ts`, `sessionBeliefs.test.ts` | store + flatten shape |
| `src/polyverdict/schema.test.ts` | validate, invalidate, coerce |

---

## Planned, not implemented

The following are documented as future work and have no runtime today:

- **Belief graph / root-cause.** `BeliefNode`, `BeliefEdge`, `BeliefDAG` types exist but are unused.
- **Axion Loop.** Loop detection and intervention. Needs embeddings and stable sessions.
- **Axion Gate.** Tool-call interception and blocking.
- **Semantic PolyVerdict.** Second-model content checks, schema registry DO, hash cache.
- **Hosted SaaS.** Multi-session dashboard, cross-session analysis.

See [BUILD-SPEC.md](./BUILD-SPEC.md) non-goals and [PLAN.md](./PLAN.md) for sequencing.

---

## Provenance

- **Author:** LatticeAG
- **GitHub:** [github.com/LatticeAG/Axion](https://github.com/LatticeAG/Axion)
- **License:** MIT
- **Brand:** LatticeAG - Agents, together.
