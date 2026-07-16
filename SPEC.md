# Axion — Full System Specification

> **Version:** 1.0.0 (spec), describing Axion Worker `0.1.0`
> **Status:** Normative for everything marked *Shipped*. Sections marked *Planned* are design targets, not implemented behavior.
> **Audience:** contributors, integrators, and agents implementing or verifying Axion.
> **Product decision record:** [BUILD-SPEC.md](./BUILD-SPEC.md) holds the locked product decisions (D1–D8). This document is the complete behavioral specification and is consistent with them. Where a conflict is ever found, BUILD-SPEC's decisions win and this document must be corrected.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are to be interpreted as described in RFC 2119.

---

## Table of contents

1. [Product overview](#1-product-overview)
2. [Goals and non-goals](#2-goals-and-non-goals)
3. [Glossary](#3-glossary)
4. [System architecture](#4-system-architecture)
5. [HTTP surface and routing](#5-http-surface-and-routing)
6. [Authentication and credential resolution](#6-authentication-and-credential-resolution)
7. [Proxy request lifecycle](#7-proxy-request-lifecycle)
8. [Session model](#8-session-model)
9. [Observe path](#9-observe-path)
10. [Content normalization](#10-content-normalization)
11. [Provider adapters](#11-provider-adapters)
12. [Belief extraction engine (Axion Lens)](#12-belief-extraction-engine-axion-lens)
13. [Data model](#13-data-model)
14. [Session state layer (Durable Object)](#14-session-state-layer-durable-object)
15. [Beliefs read API](#15-beliefs-read-api)
16. [PolyVerdict enforce path](#16-polyverdict-enforce-path)
17. [Dashboard](#17-dashboard)
18. [Error handling matrix](#18-error-handling-matrix)
19. [Configuration and deployment](#19-configuration-and-deployment)
20. [Security model](#20-security-model)
21. [Performance and latency](#21-performance-and-latency)
22. [Limits and constraints](#22-limits-and-constraints)
23. [Observability](#23-observability)
24. [Testing and CI](#24-testing-and-ci)
25. [Compatibility and versioning](#25-compatibility-and-versioning)
26. [Planned layers (not implemented)](#26-planned-layers-not-implemented)
27. [Appendix A: header reference](#27-appendix-a-header-reference)
28. [Appendix B: worked examples](#28-appendix-b-worked-examples)
29. [Document history](#29-document-history)

---

## 1. Product overview

### 1.1 What Axion is

Axion is **agent cognitive middleware**: a Cloudflare Worker that sits between an AI agent and a model API. An operator points an agent at Axion by overriding the agent's base URL. Axion forwards each request to the upstream model API, streams the response back to the agent with zero added latency, and — after delivery — parses the assistant text for **reasoning fragments** (causal claims, assumptions, intentions, cited evidence). Each fragment is stamped with a confidence score and a session id and appended to a per-session timeline. A local dashboard reads the timeline back.

```
Agent  <->  Axion (Cloudflare Worker)  <->  Model API
```

No agent code changes are required. Any client that speaks the OpenAI Chat Completions API or the Anthropic Messages API and supports a base-URL override works.

### 1.2 The problem

Agents make decisions you cannot see. Observability tools show what an agent *did* — the calls, the tokens, the latency. They do not show the *reasoning behind a choice*. Axion extracts that reasoning as it streams past and lays it out as a per-session timeline you can read after the fact.

The longer-term goal is to *act* on that reasoning: detect revision loops and verify tool calls before they run. Those layers (Loop, Gate) are specified in [§26](#26-planned-layers-not-implemented) and are **not implemented**.

### 1.3 The three layers plus one

| Layer | Name | Status | One-line description |
|---|---|---|---|
| 1 | **Axion Lens** | **Shipped** (observe path) | Read-only extraction of reasoning fragments into a per-session timeline. Cannot change agent behavior. |
| 2 | **Axion Loop** | Planned ([§26.2](#262-axion-loop-planned)) | Detect when an agent repeats the same reasoning; inject targeted feedback instead of a hard kill. |
| 3 | **Axion Gate** | Planned ([§26.3](#263-axion-gate-planned)) | Verify tool calls before execution; block bad ones. |
| — | **PolyVerdict** | **Shipped** (syntax path, opt-in) | Structured-output enforcement: validate + type-coerce model output against a JSON Schema, retry with hints, fail with 422. |

### 1.4 Brand

**Axion** is named after the theorized particle that has never been directly observed and is detected only through its effects. Agent beliefs are the same: invisible, but they drive every decision.

Axion is built by **LatticeAG** — *Agents, together.* License: MIT.

---

## 2. Goals and non-goals

### 2.1 Goals (Phase 1, shipped)

- **G1 — Drop-in.** Integration is a base-URL override plus an optional header. No SDK, no agent code changes.
- **G2 — Zero added latency on the observe path.** The caller's response bytes MUST NOT be buffered, delayed, or modified by observation. All analysis happens after delivery.
- **G3 — Never break the proxy.** Extraction and storage failures MUST be swallowed (logged, not raised). A broken lens must never turn a working agent request into an error.
- **G4 — No model dependency for observation.** Belief extraction is rule-based regex work, sub-millisecond, no model call, no third-party service.
- **G5 — Zero runtime dependencies.** The Worker ships with an empty `dependencies` set. `wrangler`, `typescript`, and `vitest` are dev-only.
- **G6 — Fail-closed auth.** The Worker never invents credentials. If neither the caller nor the server configuration provides a key, the request is rejected with 401. The literal string `Bearer undefined` MUST never be sent upstream.
- **G7 — Honest scope.** Documentation and API surface must not imply unbuilt features (graph, loop detection, gating, semantic verification).

### 2.2 Non-goals (Phase 1 — do not build)

Per BUILD-SPEC non-goals, all of these are explicitly out of scope for the current phase:

- Belief DAG construction, parent/child edges, root-cause backtracking routes.
- `/api/sessions` registry or any session enumeration API.
- Axion Loop (loop detection) and Axion Gate (tool-call interception).
- Semantic PolyVerdict, second-model verification, hallucination checks.
- Schema registry Durable Object; schema+prompt hash cache.
- Hosted multi-session SaaS dashboard, cross-session analysis, team sharing, alerting.
- Rate limiting (documented as future work in [SECURITY.md](./SECURITY.md)).

---

## 3. Glossary

| Term | Definition |
|---|---|
| **Agent** | Any client program calling a model API through Axion (an autonomous agent, a script, `curl`). |
| **Assistant text** | The plain-text content of a model's assistant message, after provider-specific normalization ([§10](#10-content-normalization)). |
| **Belief** | A reasoning fragment extracted from assistant text: one `ExtractedBelief` record ([§13.1](#131-extractedbelief)). |
| **Belief batch** | The set of beliefs extracted from a single response, stored atomically ([§13.2](#132-beliefbatch)). |
| **Enforce path** | The opt-in PolyVerdict code path, entered only when a schema trigger is present ([§16](#16-polyverdict-enforce-path)). |
| **Observe path** | The default proxy code path: tee, stream, extract in background ([§9](#9-observe-path)). |
| **Provider** | An upstream API dialect. Phase 1 supports `openai` (Chat Completions) and `anthropic` (Messages). |
| **Provider adapter** | The per-provider strategy object implementing routing, validation, and text extraction ([§11](#11-provider-adapters)). |
| **Schema trigger** | The presence of a JSON Schema on a request via header or body, which switches the request to the enforce path ([§16.1](#161-trigger-detection)). |
| **Session** | A correlation scope for beliefs, identified by a caller-chosen string or a generated UUID ([§8](#8-session-model)). |
| **SSE** | Server-Sent Events, the streaming transport used by both supported providers. |
| **Tee** | Splitting a response body with `ReadableStream.tee()` into a caller branch and an extraction branch ([§9.4](#94-tee-semantics)). |
| **Upstream** | The real model API the Worker forwards to (`UPSTREAM_API_URL`). |

---

## 4. System architecture

### 4.1 Component diagram

```
Agent (OpenAI- or Anthropic-compatible; sends x-axion-session)
  |
  v
Axion Worker (Cloudflare)                          src/proxy/index.ts (entry)
  |- Routing                                        index.ts fetch()
  |- Auth: passthrough / server key / 401           auth.ts
  |- Provider adapters (match, validate, extract)   providers/{openai,anthropic,index,types}.ts
  |- Observe: tee + SSE parse                       stream.ts
  |- Content normalization                          content.ts
  |- Background extraction glue                     extraction.ts
  |- Lens engine (patterns + confidence)            ../lens/{patterns,extract,types}.ts
  |- PolyVerdict enforce (opt-in)                   ../polyverdict/{enforce,schema,types}.ts
  |- Beliefs read API                               beliefs.ts
  |- Dashboard asset serving                        routes.ts
  |
  |-- SessionDurableObject (one per session)        ../state/SessionDurableObject.ts
  |     append-only belief batches in DO storage    ../state/sessionBeliefs.ts (pure helpers)
  |
  v
Model API (UPSTREAM_API_URL, default https://api.openai.com)

Dashboard (static React SPA, served from the ASSETS binding)   src/dashboard/{index.html,app.js,styles.css}
```

### 4.2 Module map

| Path | Responsibility |
|---|---|
| `src/proxy/index.ts` | Worker entry point. Routing, observe path orchestration, enforce loop orchestration, response shaping, error helpers. Re-exports `SessionDurableObject`. |
| `src/proxy/auth.ts` | `resolveUpstreamHeaders`: passthrough-first credential resolution ([§6](#6-authentication-and-credential-resolution)). |
| `src/proxy/stream.ts` | `teeResponseForExtraction`, `SseLineParser`, per-provider SSE payload parsers ([§9.4](#94-tee-semantics)–[§9.6](#96-text-decoding-rules)). |
| `src/proxy/content.ts` | `extractAssistantText` and per-provider non-stream body parsers ([§10](#10-content-normalization)). |
| `src/proxy/extraction.ts` | `runExtraction`: background glue from proxy to lens to Durable Object ([§9.7](#97-background-extraction-contract)). |
| `src/proxy/beliefs.ts` | `GET /api/beliefs/:sessionId` handler ([§15](#15-beliefs-read-api)). |
| `src/proxy/routes.ts` | Dashboard static-asset handler ([§17.1](#171-serving)). |
| `src/proxy/providers/` | `ProviderAdapter` interface, OpenAI and Anthropic adapters, `matchProvider` registry ([§11](#11-provider-adapters)). |
| `src/proxy/types.ts` | `Env` bindings, `ExtractionResult`, stream chunk types. |
| `src/lens/patterns.ts` | `BELIEF_PATTERNS`, `CONFIDENCE_MARKERS`, confidence constants ([§12.2](#122-pattern-registry), [§12.5](#125-confidence-algorithm)). |
| `src/lens/extract.ts` | `extractBeliefs`: scan, dedupe, confidence, shaping ([§12.1](#121-pipeline)). |
| `src/lens/types.ts` | `ExtractedBelief` and the `@planned` graph types ([§13](#13-data-model)). |
| `src/polyverdict/enforce.ts` | Trigger detection, `enforceOnce`, retry-hint builders, `runEnforceLoop` driver ([§16](#16-polyverdict-enforce-path)). |
| `src/polyverdict/schema.ts` | JSON Schema subset validator + coercion, fence stripping, JSON span extraction ([§16.5](#165-json-schema-subset)–[§16.9](#169-validation-error-message-format)). |
| `src/polyverdict/types.ts` | PolyVerdict shared types. |
| `src/state/SessionDurableObject.ts` | Per-session Durable Object: append batches, flatten on read ([§14](#14-session-state-layer-durable-object)). |
| `src/state/sessionBeliefs.ts` | Pure helpers: `flattenBeliefBatches`, `resolveSessionId`. |
| `src/dashboard/` | Static SPA: `index.html`, `app.js` (React via CDN, no build step), `styles.css` ([§17](#17-dashboard)). |

### 4.3 Data flow summary

1. **Proxy write path (observe):** agent request → auth → upstream → tee → (caller gets bytes unmodified) → background: accumulate → normalize to assistant text → `extractBeliefs` → `POST /store-beliefs` on the session's Durable Object.
2. **Proxy write path (enforce):** agent request with schema → auth → loop ≤ 3 { upstream (non-stream) → parse JSON → validate/coerce } → success: provider-shaped 200 + background Lens on the delivered JSON text; exhaustion: 422 + background Lens on the last text.
3. **Read path:** dashboard (or any HTTP client) → `GET /api/beliefs/:sessionId` → Durable Object `GET /beliefs` → flattened `{ sessionId, beliefs[] }`.

---

## 5. HTTP surface and routing

### 5.1 Route table

Routes are evaluated in this exact order by the Worker's `fetch` handler. The first match wins.

| # | Match condition | Handler | Behavior |
|---|---|---|---|
| 1 | pathname starts with `/api/beliefs/` **and** method is `GET` | `fetchBeliefs` | Beliefs read API ([§15](#15-beliefs-read-api)) |
| 2 | pathname is `/dashboard`, `/dashboard/`, or starts with `/dashboard/` (any method) | `handleDashboard` | Dashboard static assets ([§17.1](#171-serving)) |
| 3 | a provider adapter's `match(pathname, method)` returns true | `proxyProviderRequest` | Model proxy ([§7](#7-proxy-request-lifecycle)) |
| 4 | pathname is exactly `/` | — | `302` redirect to `/dashboard` (absolute URL derived from the request URL) |
| 5 | anything else | — | `404` with plain-text body `Not Found` |

Provider matches in Phase 1 (see [§11](#11-provider-adapters)):

- `POST /v1/chat/completions` → OpenAI adapter.
- `POST /v1/messages` → Anthropic adapter.

Method comparison in adapters is case-insensitive (`method.toUpperCase() === "POST"`). Path comparison is exact (no trailing-slash tolerance, no prefix matching).

### 5.2 Unmatched method/path combinations

- Non-`GET` requests to `/api/beliefs/...` do **not** match rule 1; they fall through and (matching no provider) return `404`.
- `GET /v1/chat/completions` matches no rule and returns `404`.
- There is **no** `/api/sessions` route, no health-check route, no OPTIONS/CORS-preflight handler, and no `/metrics` route in Phase 1.

---

## 6. Authentication and credential resolution

Implemented in `src/proxy/auth.ts` as `resolveUpstreamHeaders(request, env, provider)`. This section is normative (BUILD-SPEC D1).

### 6.1 Resolution algorithm

The resolver builds a **fresh** header set for the upstream request. It MUST NOT copy arbitrary caller headers ([§6.4](#64-headers-sent-upstream)). Resolution order:

1. **Caller `Authorization` present** (after trimming whitespace, non-empty): forward its value verbatim as `Authorization`. This covers direct API keys and gateway tokens.
2. **Else caller `x-api-key` present** (trimmed, non-empty): forward its value as `x-api-key` (the Anthropic-style key header).
3. **Else `env.UPSTREAM_API_KEY` set and non-empty after trim** (the server key):
   - Anthropic provider: send it as `x-api-key: <key>`.
   - Any other provider: send it as `Authorization: Bearer <key>`.
4. **Else:** fail closed. Return a ready-to-send `401` response with body:

```json
{ "error": { "message": "Provide Authorization or x-api-key, or configure UPSTREAM_API_KEY" } }
```

Because the server key is used only when it trims to a non-empty string, `Bearer undefined` (or `Bearer ""`) can never be emitted. This is a hard invariant (G6).

### 6.2 Result type

The resolver returns a discriminated union — callers branch on `ok` rather than catching exceptions:

```typescript
type AuthResult =
  | { ok: true; headers: Headers }     // ready-to-send upstream headers
  | { ok: false; response: Response }; // ready-to-return 401
```

### 6.3 Anthropic version header

On the Anthropic path, if the resolved header set does not already carry `anthropic-version`, the resolver sets it from the caller's `anthropic-version` header (trimmed), defaulting to **`2023-06-01`** (`DEFAULT_ANTHROPIC_VERSION`) when the caller sent none.

### 6.4 Headers sent upstream

The complete set of headers Axion may send upstream, and their sources:

| Header | Source | Condition |
|---|---|---|
| `Content-Type` | fixed `application/json` | always |
| `Authorization` | caller passthrough, or `Bearer <UPSTREAM_API_KEY>` | per [§6.1](#61-resolution-algorithm) |
| `x-api-key` | caller passthrough, or `<UPSTREAM_API_KEY>` (Anthropic) | per [§6.1](#61-resolution-algorithm) |
| `OpenAI-Organization` | caller passthrough | when the caller sent it (any provider) |
| `anthropic-version` | caller passthrough or default `2023-06-01` | Anthropic provider only |

**No other caller headers are forwarded.** In particular, `anthropic-beta`, custom tracing headers, cookies, and `User-Agent` are dropped. This is a deliberate allowlist; widening it is a spec change ([§22.3](#223-known-behavioral-constraints)).

### 6.5 Credential handling rules

- Keys MUST never be logged, stored, or echoed in responses.
- The Worker performs **no validation** of caller keys; the upstream is the authority. A bad key yields the upstream's own 401/403, passed through ([§9.2](#92-upstream-error-passthrough)).
- Deployments where callers hold keys need no server secret at all. `UPSTREAM_API_KEY` exists for the "Worker holds the key, callers omit it" deployment mode. Operators who set it SHOULD restrict who can reach the Worker, because it then acts as an open relay for that key ([§20](#20-security-model)).

---

## 7. Proxy request lifecycle

`proxyProviderRequest` in `src/proxy/index.ts` runs the shared front half of both proxy paths, in this order:

1. **Session id resolution** ([§8](#8-session-model)): `x-axion-session` header value, or a fresh `crypto.randomUUID()`.
2. **Body read and parse.** The request body is read fully as text (`request.text()`) and parsed with `JSON.parse`. On any failure → `400` `{ "error": { "message": "Invalid JSON request body" } }`. The raw body string is retained so the observe path can forward the caller's exact bytes.
3. **Provider validation.** `provider.validateRequest(body)` — Phase 1 rule for both providers: `messages` must be a non-empty array, else `400` `{ "error": { "message": "Request must include a non-empty 'messages' array" } }`.
4. **Auth resolution** ([§6](#6-authentication-and-credential-resolution)). On failure, the 401 is returned immediately.
5. **Path selection.** `detectSchemaTrigger(request.headers, body)` ([§16.1](#161-trigger-detection)):
   - trigger present → **enforce path** ([§16](#16-polyverdict-enforce-path));
   - otherwise → **observe path** ([§9](#9-observe-path)).

Note: the 400 and 401 responses above do **not** carry the `x-axion-session` header; only responses that reached an upstream call (or the enforce 422) do ([§8.3](#83-session-header-echo)).

### 7.1 Upstream URL construction

`resolveUpstreamUrl(env, path)`: take `env.UPSTREAM_API_URL` (default `https://api.openai.com` when unset/empty), strip all trailing `/` characters, and append the adapter's `upstreamPath` (which begins with `/`). The path is the same as the inbound route: `/v1/chat/completions` or `/v1/messages`. Query strings on the inbound request are ignored.

### 7.2 Upstream fetch failure

If the `fetch` to the upstream throws (network error, DNS failure), the Worker returns `502` with:

```json
{ "error": { "message": "Failed to reach upstream model API: <error message>" } }
```

---

## 8. Session model

### 8.1 Identity

A **session id** is an arbitrary non-empty string chosen by the caller. It is the sole correlation key for beliefs. Semantics:

- The caller supplies it via the `x-axion-session` request header on every proxied request belonging to the same run.
- If the header is absent, the Worker generates a UUID (v4, via `crypto.randomUUID()`) **per request**. A single call is still captured, but multi-turn correlation requires the caller to send a stable id.
- Session ids are mapped to Durable Objects via `idFromName(sessionId)` — the mapping is deterministic, so the same string always reaches the same object, globally.

### 8.2 Capability semantics

A session id is a **read capability**: anyone who knows it can read that session's beliefs ([§15](#15-beliefs-read-api), [§20](#20-security-model)). Callers SHOULD treat ids like secrets (unguessable UUIDs, not `test`).

### 8.3 Session header echo

Every response produced by a path that resolved a session id MUST carry `x-axion-session: <id>`:

- observe-path success responses (streaming and non-streaming);
- observe-path upstream error passthrough;
- enforce-path success (provider-shaped 200), enforce-path upstream error passthrough, and the enforce 422.

Responses produced before session use (400 invalid JSON, 400 validation, 401 auth) do not carry it.

### 8.4 Lifecycle

There is no session creation, closing, expiry, or deletion API in Phase 1. A session "exists" from the first stored batch and persists indefinitely ([§22.1](#221-storage-growth)).

---

## 9. Observe path

The default path. Implemented by `observeProviderRequest`. Normative property (G2): the caller's bytes are **never buffered, transformed, or delayed** — the only synchronous costs are request forwarding and the stream tee.

### 9.1 Steps

1. Compute `isStreaming = (body.stream === true)`.
2. `fetch` the upstream URL with method `POST`, the resolved auth headers, and the **original raw body string** (byte-for-byte what the caller sent).
3. On fetch exception → `502` ([§7.2](#72-upstream-fetch-failure)).
4. On non-OK upstream status → pass the upstream response through unchanged, adding the session header ([§9.2](#92-upstream-error-passthrough)).
5. Compute `isSse = isStreaming || upstream Content-Type includes "text/event-stream"`.
6. Tee the body ([§9.4](#94-tee-semantics)). Return the caller branch immediately with the session header set.
7. Register the extraction task with `ctx.waitUntil` ([§9.7](#97-background-extraction-contract)).

### 9.2 Upstream error passthrough

When the upstream returns a non-2xx status, the Worker MUST forward that response verbatim — same status, status text, headers, and body — with exactly one modification: the `x-axion-session` header is set. No extraction runs on error responses.

### 9.3 SSE detection

A response is treated as SSE when **either**:

- the request body carried `stream: true` (strict boolean comparison), or
- the upstream response `Content-Type` contains the substring `text/event-stream`.

This double check means a client that requests streaming is honored even if the upstream mislabels content type, and an upstream that streams unrequested is still parsed correctly.

### 9.4 Tee semantics

`teeResponseForExtraction(response, isSse, provider)`:

- If the response has no body, return it as-is with `accumulatedText` resolved to `""`.
- Otherwise call `response.body.tee()`, producing a **caller branch** and an **extraction branch**.
- The caller branch is wrapped in a new `Response` preserving the upstream status, status text, and headers. It is never read by Axion code — backpressure and pacing are the runtime's.
- The extraction branch is consumed by an async accumulator that resolves to a single string:
  - **SSE:** each decoded chunk is fed to an `SseLineParser` ([§9.5](#95-sse-parsing)); for every complete `data:` payload, the provider-specific payload parser extracts delta text, and the texts are concatenated.
  - **Non-SSE:** decoded chunks are concatenated raw (the full JSON body; parsed later by [§10](#10-content-normalization)).
- **Error swallowing:** any read error in the accumulator is caught and ignored; the accumulator resolves with whatever text it gathered. Extraction must never break the proxy (G3). The reader lock is always released (best-effort) in a `finally` block.

### 9.5 SSE parsing

`SseLineParser` is a small stateful parser fed decoded text chunks. Normative behavior:

- **Record delimiter:** records are separated by a blank line. Both `\n\n` and `\r\n\r\n` are recognized; when both appear, the earliest index wins. A single `read()` may deliver a partial record or several records; the parser buffers across feeds.
- **Field handling within a record:** lines are split on `\r?\n`. Empty lines and comment lines (starting with `:`) are skipped. `event:`, `id:`, and `retry:` fields are ignored. Every `data:` line contributes its payload — the `data:` prefix is removed along with **at most one** leading space, per the SSE spec.
- **Multi-line data:** multiple `data:` lines within one record are joined with `\n` (per spec) into one payload.
- **Flush:** after the stream ends, `flush()` processes any buffered trailing record that lacked a final delimiter, applying the same data-line rules.

**Per-provider payload parsing** (each complete payload string):

| Provider | Function | Text source | Terminal signal |
|---|---|---|---|
| OpenAI | `parseSseData` | `choices[0].delta.content` — a string, or an array of parts (bare strings or `{ text }` objects), concatenated | payload `[DONE]` |
| Anthropic | `parseAnthropicSseData` | events with `type === "content_block_delta"` and `delta.type === "text_delta"` → `delta.text` | event `type === "message_stop"` (Anthropic has no `[DONE]`) |

Payloads that are not JSON, or not a recognized shape, contribute empty text and are otherwise ignored (never an error). Non-text deltas (tool-use deltas, `input_json_delta`, thinking deltas) contribute nothing in Phase 1.

### 9.6 Text decoding rules

The accumulator MUST decode with a single `TextDecoder` using `decoder.decode(value, { stream: true })` per chunk, followed by a final `decoder.decode()` flush after the last read. This releases bytes the decoder held back mid multi-byte UTF-8 sequence. Any text produced by the final flush is processed through the same SSE/raw route as ordinary chunks, and the SSE parser's own `flush()` runs last.

### 9.7 Background extraction contract

The extraction task runs inside `ctx.waitUntil` — after the response has been handed to the caller, without extending caller latency:

1. Await the accumulated text promise.
2. `extractAssistantText({ provider, isSse, accumulated })` ([§10](#10-content-normalization)).
3. `runExtraction(env, sessionId, text)` (`src/proxy/extraction.ts`):
   - If `text` is empty or whitespace-only, do nothing.
   - Call `extractBeliefs(text, { sessionId })` ([§12](#12-belief-extraction-engine-axion-lens)). On throw: log `axion: belief extraction failed` via `console.error` and stop. Never rethrow.
   - Build an `ExtractionResult` `{ sessionId, beliefs, rawText: text, timestamp: Date.now() }`.
   - Resolve the session's Durable Object (`env.SESSION.idFromName(sessionId)` → stub) and `POST https://internal/store-beliefs` with the JSON result. Non-OK DO responses and thrown errors are logged (`axion: failed to store beliefs in DO` / `axion: DO store threw`) and swallowed.

A batch is stored even when `beliefs` is empty (the raw text and timestamp still record that a response occurred), as long as the assistant text itself was non-empty.

---

## 10. Content normalization

`extractAssistantText(opts)` in `src/proxy/content.ts` converts a completed response into a single plain-text string for extraction. **Raw JSON is never fed to the lens.** All extractors are defensive: malformed or unexpected bodies yield `""`, never a throw.

| Input | Rule |
|---|---|
| SSE (any provider) | `accumulated` already holds joined delta text (built in [§9.5](#95-sse-parsing)); return it trimmed. |
| Non-SSE, OpenAI | `JSON.parse` the body; read `choices[0].message.content`. A string is used directly; an array is concatenated part-by-part (bare strings and `{ text: string }` objects). Trim. |
| Non-SSE, Anthropic | `JSON.parse` the body; concatenate every `content[]` block with `type === "text"` (their `.text` values). A bare string `content` is accepted leniently. Trim. |

---

## 11. Provider adapters

### 11.1 Contract

```typescript
interface ProviderAdapter {
  id: "openai" | "anthropic";                       // ProviderId
  match(pathname: string, method: string): boolean;  // does this adapter own the route?
  upstreamPath: string;                              // appended to UPSTREAM_API_URL
  validateRequest(body: unknown): ValidationResult;  // { ok: true } | { ok: false; message }
  extractAssistantText(rawBody: string): string;     // non-streaming body → assistant text
}
```

The registry (`providers/index.ts`) holds adapters in match-priority order: `[openaiAdapter, anthropicAdapter]`. `matchProvider(pathname, method)` returns the first adapter whose `match` claims the request, or `null`. `getProvider(id)` looks up by id and throws on an unknown id (programmer error, not a request-time path).

### 11.2 OpenAI adapter

| Property | Value |
|---|---|
| Route | `POST /v1/chat/completions` (exact path, case-insensitive method) |
| Upstream path | `/v1/chat/completions` |
| Request validation | `messages` is a non-empty array |
| Streaming text | `choices[0].delta.content` per SSE chunk ([§9.5](#95-sse-parsing)) |
| Non-streaming text | `choices[0].message.content` (string or parts array) ([§10](#10-content-normalization)) |
| Auth headers | `Authorization` (passthrough or `Bearer <server key>`), optional `OpenAI-Organization` |

### 11.3 Anthropic adapter

| Property | Value |
|---|---|
| Route | `POST /v1/messages` (exact path, case-insensitive method) |
| Upstream path | `/v1/messages` |
| Request validation | `messages` is a non-empty array |
| Streaming text | `content_block_delta` events with `delta.type === "text_delta"` ([§9.5](#95-sse-parsing)) |
| Non-streaming text | join of `content[]` blocks with `type === "text"` ([§10](#10-content-normalization)) |
| Auth headers | `x-api-key` (passthrough or server key), `anthropic-version` (passthrough or default `2023-06-01`) |

### 11.4 Adding a provider

A new provider is added by implementing `ProviderAdapter`, adding an SSE payload parser to `stream.ts` (and wiring `sseParserFor`), a non-stream extractor in `content.ts`, any provider-specific auth in `auth.ts`, and appending the adapter to `PROVIDERS`. No routing changes are needed — the registry walk handles dispatch. Enforce-path support additionally requires a retry-message builder ([§16.10](#1610-retry-hint-construction)) and a success response shape ([§16.11](#1611-success-response-shapes)).

---

## 12. Belief extraction engine (Axion Lens)

Rule-based, regex-only, no model call, synchronous CPU work (wrapped in an async signature for future-proofing). Public contract:

```typescript
extractBeliefs(text: string, opts?: {
  sessionId?: string;      // stamped on every belief; default: random UUID
  uuid?: () => string;     // injectable id generator (tests); default crypto.randomUUID
  now?: () => number;      // injectable clock (tests); default Date.now
}): Promise<ExtractedBelief[]>
```

### 12.1 Pipeline

1. **Empty guard.** Empty or whitespace-only text → `[]`.
2. **Scan.** Every pattern in `BELIEF_PATTERNS` runs globally over the text (the engine adds the `g` flag; patterns are authored with `i` only). Each match records: pattern index, type, captured belief text (`group`), optional `evidence` / `action` captures, full matched substring, start offset, and 1-indexed line number. Matches whose belief capture is empty after trimming are skipped.
3. **Sort.** Stable order by start offset ascending, ties broken by pattern index ascending (list order = precedence).
4. **Dedupe.** Walk the sorted list; drop any match whose span (`[index, index + fullMatch.length)`) is **wholly contained** within the span of an already-kept match. This implements "first pattern wins per span": once a region is claimed, nested sub-matches from later patterns are discarded. Partial overlaps are both kept.
5. **Confidence.** Per surviving match: pattern baseline, adjusted by markers found in the surrounding context, clamped ([§12.5](#125-confidence-algorithm)).
6. **Shape.** Emit an `ExtractedBelief` per survivor: fresh UUID per belief, one shared timestamp for the whole call, trimmed `belief` / `evidence` / `actionTaken` strings (empty-after-trim optional fields become `undefined`), `rawText` = trimmed full match, `line`, `sessionId`.

### 12.2 Pattern registry

`BELIEF_PATTERNS` is an ordered list of 13 patterns. Order matters (precedence). All are case-insensitive. Capture-group semantics: `group` = belief text, `evidenceGroup` = cited evidence, `actionGroup` = stated action. Clause captures are non-greedy and bounded (2–120 chars; 2–140 for `error-says`); a clause ends at `.` `;` `!` `?`, a newline, or end of string, so a match at the very end of a response is not lost for lack of trailing punctuation.

| # | Label | Type | Baseline | Regex (source) | Captures |
|---|---|---|---|---|---|
| 1 | `based-on` | evidence | 0.80 | `\bbased on (?:the )?([^.;!?\n]{2,120}?)(?:[,.;]\|\sthen\|$)` | belief = evidence = group 1 |
| 2 | `according-to` | evidence | 0.80 | `\baccording to (?:the )?([^.;!?\n]{2,120}?)(?:[,.;]\|\sthen\|$)` | belief = evidence = group 1 |
| 3 | `from-the` | evidence | 0.70 | `\bfrom the ([^.;!?\n]{2,120}?)(?:[,.;]\|\sthen\|$)` | belief = evidence = group 1 |
| 4 | `error-says` | evidence | 0.85 | `\bthe error(?: message)? (?:says\|indicates\|shows\|states) "?([^";!?\n]{2,140})"?` | belief = evidence = group 1 |
| 5 | `because-of` | causal | 0.85 | `\bbecause of\s+([^.;!?\n]{2,120}?)(?:[.;!?\n]\|$)` | belief = group 1 |
| 6 | `because` | causal | 0.85 | `\bbecause\s+(?!of\b)([^.;!?\n]{2,120}?)(?:[.;!?\n]\|$)` | belief = group 1 |
| 7 | `since-causal` | causal | 0.80 | `\bsince\s+(?!the\s+\d\|\d{4})([^.;!?\n]{2,120}?)(?:[.;!?\n]\|$)` | belief = group 1 |
| 8 | `due-to` | causal | 0.85 | `\b(?:due to\|as a result of)\s+([^.;!?\n]{2,120}?)(?:[.;!?\n]\|$)` | belief = group 1 |
| 9 | `assuming` | assumption | 0.65 | `\b(?:assuming\|presumably)\s+(?:that\s+)?([^.;!?\n]{2,120}?)(?:[.;!?\n]\|$)` | belief = group 1 |
| 10 | `i-assume` | assumption | 0.65 | `\b(?:i(?:'ll\| will)\|let's\|let us) assume\s+(?:that\s+)?([^.;!?\n]{2,120}?)(?:[.;!?\n]\|$)` | belief = group 1 |
| 11 | `if-then` | assumption | 0.60 | `\bif\s+([^,.;!?\n]{2,100}?)\s+then\s+([^.;!?\n]{2,120}?)(?:[.;!?\n]\|$)` | belief = group 1 (condition), action = group 2 |
| 12 | `i-will` | intention | 0.75 | `\b(?:i(?:'ll\| will\|i'm going to\|'m going to)\|let me\|i should\|i'm going to)\s+([^.;!?\n]{2,120}?)(?:[.;!?\n]\|$)` | belief = group 1 |
| 13 | `i-plan` | intention | 0.75 | `\bi (?:plan\|intend)\s+to\s+([^.;!?\n]{2,120}?)(?:[.;!?\n]\|$)` | belief = group 1 |

Design conventions encoded above:

- **Belief text is the reason/condition, not the connective.** "because X" → belief `X`; "if X then Y" → belief `X`, `actionTaken` `Y`.
- **`because of` is a separate pattern** placed before bare `because`, so group 1 always holds the belief text; the bare pattern excludes `of` with a negative lookahead.
- **`since` excludes temporal uses** (`since the 1990s`, `since 2021`) with a negative lookahead on digits.
- **Evidence patterns duplicate their capture** into both `belief` and `evidence` — the dashboard shows the cited text in both positions (BUILD-SPEC §5).

### 12.3 Line numbers

`line` is the 1-indexed line (counting `\n` characters) of the match's start offset within the analyzed assistant text.

### 12.4 Ids and timestamps

- `id`: UUID v4 per belief (`crypto.randomUUID()` unless injected).
- `timestamp`: Unix epoch milliseconds; one value shared by all beliefs from a single `extractBeliefs` call (they came from one response).
- If no `sessionId` is supplied, a random UUID is generated; if `crypto.randomUUID` is unavailable, the fallback format is `sess-<Date.now()>-<8 base-36 chars>`. (In the Worker, the proxy always supplies a session id.)

### 12.5 Confidence algorithm

Confidence is a **linguistic hedging heuristic, not a truth signal**. Normative algorithm (BUILD-SPEC D5):

1. Start from the matched pattern's baseline (table above).
2. Extract the **context window**: up to `MARKER_SCAN_RADIUS` = **80 characters on each side** of the full match (clamped to text bounds), including the match itself.
3. For each of the four marker categories, test its regex against the window. Each category present contributes its delta **once** (multiple hits of the same category do not stack; different categories do):

| Category | Words (case-insensitive, word-bounded) | Delta |
|---|---|---|
| `certain` | definitely, certainly, absolutely, without a doubt, guaranteed | **+0.2** |
| `likely` | probably, likely, most likely, almost certainly, highly likely | **+0.1** |
| `possible` | might, could be, possibly, may, perhaps | **−0.2** |
| `uncertain` | not sure, uncertain, unsure, unclear | **−0.3** |

4. Sum baseline + deltas; **clamp to `[0.1, 1.0]`** (`CONFIDENCE_MIN`, `CONFIDENCE_MAX`). `NaN` clamps to `0.1`.

`DEFAULT_CONFIDENCE` = 0.7 is exported as the nominal midpoint for consumers; every shipped pattern defines its own baseline, so it is not used at runtime.

**Worked examples:**

- `"This fails because the port is busy."` → `because`, baseline 0.85, no markers → **0.85**.
- `"This might fail because the port is busy."` → baseline 0.85, `possible` (−0.2) → **0.65**.
- `"It definitely broke because the config might be stale."` → baseline 0.85, `certain` (+0.2) and `possible` (−0.2) → **0.85**.
- `"Not sure, but possibly it's because DNS."` → baseline 0.85, `uncertain` (−0.3) + `possible` (−0.2) → 0.35.

**Dedupe example:** `"I'll assume the config is valid."` matches both `i-assume` (assumption, pattern 10) and `i-will` (intention, pattern 12) at the same start offset with the same span. The tie-break keeps the lower pattern index (`i-assume`); `i-will`'s span is wholly contained and is dropped. One assumption belief is emitted.

### 12.6 Accuracy caveats (normative disclosure)

- Extraction misses reasoning that does not use trigger phrases and can mis-parse unusual phrasing.
- Confidence reflects how the model **hedged**, nothing more. Documentation and UI MUST NOT present it as correctness or claim invalidation (hence the dashboard filter is "Low confidence", not "Wrong" — BUILD-SPEC D6).
- Only assistant *text* is analyzed. Tool-call arguments, thinking blocks, and non-text content contribute nothing in Phase 1.

---

## 13. Data model

### 13.1 `ExtractedBelief`

The canonical record shared by the lens, the proxy, the Durable Object, the read API, and the dashboard:

```typescript
interface ExtractedBelief {
  id: string;            // UUID v4, unique per belief
  sessionId: string;     // owning session ([§8])
  type: 'causal' | 'assumption' | 'intention' | 'evidence';
  belief: string;        // extracted belief text, trimmed
  evidence?: string;     // cited evidence, when the pattern captured one
  confidence: number;    // [0.1, 1.0]; see §12.5
  actionTaken?: string;  // stated action, when captured (if-then patterns)
  timestamp: number;     // Unix epoch ms; shared per source response
  rawText: string;       // the full matched substring, trimmed (audit trail)
  line: number;          // 1-indexed line of the match in the source text
}
```

Optional fields are omitted (not `null`) when absent.

### 13.2 `BeliefBatch`

The unit of storage in the Durable Object — one batch per extracted response:

```typescript
interface BeliefBatch {
  beliefs: ExtractedBelief[]; // possibly empty
  rawText: string;            // the full assistant text of the response
  timestamp: number;          // Unix epoch ms of extraction
}
```

`ExtractionResult` (the wire shape POSTed to the DO) is a `BeliefBatch` plus `sessionId`.

### 13.3 Planned graph types (`@planned`, no runtime)

`BeliefNode` (adds `parentIds`, `childIds`, `invalidated?`), `BeliefEdge` (`relation: 'derived' | 'contradicts' | 'supports'`), and `BeliefDAG` (`nodes`, `edges`, `sequence`) exist in `src/lens/types.ts` as forward-declared types only (BUILD-SPEC D2). **No code constructs, stores, or serves them.** Their presence MUST NOT be read as a shipped graph. See [§26.4](#264-belief-graph-planned).

---

## 14. Session state layer (Durable Object)

`SessionDurableObject` — one instance per session, addressed by `idFromName(sessionId)`. Phase 1 is an **append-only chronological timeline store**, not a graph (BUILD-SPEC D2). Bound as `SESSION` in `wrangler.toml`, with migration tag `v1`.

### 14.1 Internal API

The DO is reachable only from the Worker via its stub (the `https://internal/` hostname is arbitrary). Two routes:

**`POST /store-beliefs`** — append one batch.

- Body: `ExtractionResult` JSON.
- Behavior: read the `"beliefs"` storage key (default `[]`), push `{ beliefs, rawText, timestamp }`, write back. Then, when `sessionId` is non-empty, write it to the `"sessionName"` key (refreshed on **every** write).
- Response: `200` `{ "ok": true, "count": <beliefs in this batch> }`.

**`GET /beliefs`** — read the flattened timeline.

- Query: optional `sessionId` hint (the human id from the public API path).
- Behavior: read all batches; `flattenBeliefBatches` concatenates each batch's `beliefs` in storage order (tolerant of malformed entries — non-array batches or missing `beliefs` contribute nothing, never throw). `resolveSessionId` picks the reply id: stored `sessionName` (trimmed) if present, else the trimmed hint, else `""`. The opaque Durable Object id is **never** leaked.
- Response: `200` `{ "sessionId": <human id>, "beliefs": ExtractedBelief[] }`.

Anything else → `404` plain-text `Not Found`.

### 14.2 Storage schema

| Key | Type | Semantics |
|---|---|---|
| `"beliefs"` | `BeliefBatch[]` | Append-only list of batches, in arrival order. |
| `"sessionName"` | `string` | The human session id; written on every store call. |

### 14.3 Durability and consistency

- Batches persist in Durable Object storage, surviving DO eviction and redeploys.
- The Durable Object's single-threaded execution model serializes concurrent `store-beliefs` calls; the read-modify-write append is safe within one object.
- Ordering: batches are ordered by arrival at the DO. For concurrent requests within one session, arrival order is the ordering guarantee (not response start time).

### 14.4 Known limitation — unbounded growth

Nothing trims old batches. Long-lived session ids grow without limit, and because all batches live under a single storage key, the per-value storage limit of the platform (128 KiB per value) is the practical ceiling for one session's history; a write beyond it fails and is logged/swallowed per G3 ([§22.1](#221-storage-growth)). Fixing this (per-batch keys, trimming, TTL) is future work and would be a spec change.

---

## 15. Beliefs read API

**`GET /api/beliefs/:sessionId`** (`src/proxy/beliefs.ts`).

### 15.1 Request

- `:sessionId` is everything after `/api/beliefs/` up to the first `/`, `?`, or `#`. It is URL-decoded by the platform as part of the path.
- No request headers are required. **The endpoint is unauthenticated by design in Phase 1** ([§20.2](#202-threat-model)).

### 15.2 Behavior

1. Missing/empty id → `400` `{ "error": { "message": "Missing session ID in path" } }`.
2. Resolve the Durable Object by `idFromName(sessionId)` and fetch `GET https://internal/beliefs?sessionId=<urlencoded id>` (the hint lets the DO echo a human id even before any write).
3. DO fetch throw → `502` `{ "error": { "message": "Failed to reach session state: <detail>" } }`.
4. Otherwise pass the DO response through, forcing `Content-Type: application/json` and `Access-Control-Allow-Origin: *`.

### 15.3 Response shape

```json
{
  "sessionId": "my-session",
  "beliefs": [
    {
      "id": "6f0d…",
      "sessionId": "my-session",
      "type": "causal",
      "belief": "the port is busy",
      "confidence": 0.65,
      "timestamp": 1752681600000,
      "rawText": "because the port is busy.",
      "line": 3
    }
  ]
}
```

A session that has never stored anything returns `200` with `beliefs: []` (and the hint echoed as `sessionId`) — an empty session is indistinguishable from a nonexistent one, deliberately (no session-existence oracle).

### 15.4 CORS

`Access-Control-Allow-Origin: *` is set on success and error responses from this endpoint. There is no preflight handler; only simple GETs are expected.

---

## 16. PolyVerdict enforce path

Opt-in structured-output enforcement (BUILD-SPEC D7/D8). It runs **only** when a schema trigger is present; the observe path is otherwise untouched. Enforce is buffered by design — the zero-latency guarantee does not apply. Enforce always returns non-streaming JSON, even if the client asked to stream (validating a partial stream is not meaningful).

### 16.1 Trigger detection

`detectSchemaTrigger(headers, body)` returns `{ schema, name? }` or `null`. Two triggers; **header wins**:

1. **Header `x-axion-schema`.** Value must parse as JSON. Parse is attempted directly; on failure, retried after `decodeURIComponent` (headers are often URL-encoded). If both fail, the header trigger is `null` (the body trigger is then consulted; if that also fails the request proceeds on the **observe path** — a malformed schema header is silently ignored, not an error).
2. **Body `response_format`** (OpenAI structured-output style): `response_format.type === "json_schema"` and `response_format.json_schema` is an object containing a `schema` key. `json_schema.name` is carried as the trigger `name` when it is a string.

No trigger → the request never enters this path.

### 16.2 Enforce loop

`enforceProviderRequest` runs up to `MAX_ENFORCE_ATTEMPTS` = **3** total upstream attempts:

1. Build the attempt body: the original parsed body spread, with `stream: false` forced, `messages` replaced by the current message list, and `response_format` **deleted** (the Worker owns validation; the upstream must not also enforce).
2. `fetch` upstream (same URL construction as observe). Fetch throw → `502` ([§7.2](#72-upstream-fetch-failure)). Non-OK upstream → passthrough with session header, terminating the loop ([§9.2](#92-upstream-error-passthrough)).
3. Read the full body text; extract assistant text via `provider.extractAssistantText` ([§10](#10-content-normalization)).
4. `enforceOnce(text, schema)`: parse JSON from the text ([§16.4](#164-json-extraction-from-assistant-text)) → `validateAndCoerce` ([§16.5](#165-json-schema-subset)).
5. **Success:** serialize the coerced value (`JSON.stringify`) as the delivered text; schedule Lens on it via `ctx.waitUntil` (beliefs come from validated output); return the provider-shaped 200 ([§16.11](#1611-success-response-shapes)) with the session header.
6. **Failure with attempts left:** append retry turns to the message list ([§16.10](#1610-retry-hint-construction)) and loop.
7. **Exhausted:** schedule Lens on the last assistant text; return the 422 ([§16.12](#1612-failure-response-422)).

### 16.3 Request mutation rules

- All original body fields other than `stream`, `messages`, and `response_format` pass through to the upstream unchanged on every attempt (`model`, `temperature`, `max_tokens`, Anthropic `system`, etc.).
- The message list grows across attempts (original + failed assistant turn + correction turn, per retry). The original request object is not mutated; each attempt builds a fresh body.

### 16.4 JSON extraction from assistant text

`parseJsonFromAssistant(text)`:

1. **Strip Markdown fences** (`stripMarkdownFences`): find the first fenced block anywhere in the trimmed text — ` ```json … ``` `, ` ``` … ``` `, with an optional language tag `[A-Za-z0-9_-]+` — and use its inner content (trimmed). No fence → the trimmed input.
2. **Direct parse:** `JSON.parse` the result. Empty string → error `"empty response"`.
3. **Balanced-span fallback:** on direct-parse failure, scan for the first `{` or `[` (earliest of the two) and walk forward tracking bracket depth, **skipping brackets inside string literals** (with `\` escape handling). If a balanced span closes, `JSON.parse` it.
4. All failing → `{ ok: false, error: <original parse error message> }`, which surfaces as the violation `` `JSON parse failed: <detail>` ``.

### 16.5 JSON Schema subset

`validateAndCoerce(data, schema)` implements a minimal, zero-dependency subset. Recognized keywords:

| Keyword | Support |
|---|---|
| `type` | Single type or union array, over: `object`, `array`, `string`, `number`, `integer`, `boolean`, `null`. Unknown type names impose **no constraint**. |
| `properties` | Nested schemas per key. Only keys **present** in the value are recursed into; absence is `required`'s job. Unknown keys in the value are allowed and passed through untouched (no `additionalProperties` support). |
| `required` | Array of property names that must be present (`in` check). Enforced even without a sibling `properties`. Non-string entries are ignored. |
| `items` | Single schema (applied to every element) or tuple array (schema per position; elements beyond the tuple length pass through unvalidated). |
| `enum` | Membership check by deep structural equality (JSON serialization comparison), evaluated **after** coercion so `"42"` coerced to `42` can match `enum: [42]`. |
| anything else | **Ignored, never an error** — `format`, `pattern`, `minimum`, `minLength`, `additionalProperties`, `$ref`, etc. have no effect in v1. |

A non-object schema (including boolean `true`) imposes no constraints. Structural recursion applies even without an explicit `type` — a bare `{ properties: … }` still validates nested objects.

The result is `{ ok: true, value }` with the coerced value, or `{ ok: false, errors: string[] }`. Validation collects **all** violations in one pass (it does not stop at the first).

### 16.6 Type coercion matrix

Coercion is best-effort and unambiguous-only. Applied before enum checks.

| Schema type | Value | Result |
|---|---|---|
| `string` | string | unchanged |
| `string` | finite number | `String(value)` |
| `string` | boolean | `"true"` / `"false"` |
| `number` | finite number | unchanged |
| `number` | numeric string (`Number()` finite, not empty/whitespace) | `Number(value)` |
| `integer` | integer number | unchanged |
| `integer` | string of an integer value | `Number(value)` |
| `boolean` | boolean | unchanged |
| `boolean` | exactly `"true"` / `"false"` | `true` / `false` |
| `null` | `null` | unchanged |
| `object` / `array` | matching container | unchanged (then recursed) |
| any | anything else | **violation**; original value kept in output |

Notes: `NaN`/`Infinity` never satisfy `number`. `"yes"`, `"1"` (for boolean), `"3.5"` (for integer) do not coerce. Objects/arrays are never coerced to primitives or vice versa.

### 16.7 Union types

For `type: [t1, t2, …]`: unknown names are filtered out first (an all-unknown union imposes no constraint). If the value already matches any listed type (strictly, no coercion), it is kept as-is. Otherwise coercion is attempted against each listed type in order; the first coercion that produces no violation wins. If none succeeds, one violation is reported: `` `<path>: expected one of [t1, t2], got <actual>` ``.

### 16.8 Object and array traversal

- Objects are shallow-copied; each declared property present in the value is replaced by its recursively coerced result. `required` runs against the original value.
- Arrays are mapped element-wise (single-schema `items`) or position-wise (tuple `items`).
- Paths: root is `$`; object members append `.<key>`; array elements append `[<index>]` (e.g. `$.items[2].price`).

### 16.9 Validation error message format

One human-readable string per violation, always prefixed with the JSON path:

| Violation | Format |
|---|---|
| type mismatch | `<path>: expected <type>, got <actualTypeName>` |
| union mismatch | `<path>: expected one of [<types>], got <actualTypeName>` |
| missing required | `<path>: missing required property "<name>"` |
| enum mismatch | `<path>: value <valuePreview> is not one of <enumPreview>` |

Actual type names: `null`, `array`, or `typeof`. Value previews are JSON, truncated to 80 characters with a `...` suffix.

### 16.10 Retry-hint construction

On a failed attempt with attempts remaining, two turns are appended to the message list (input list is not mutated):

1. An `assistant` turn echoing the failed output verbatim (skipped when the assistant text was empty), so the model can see its own mistake.
2. A `user` correction turn with this exact structure (`buildViolationHint`):

```
Your previous response did not satisfy the required JSON schema "<name>".

Schema violations:
- <error 1>
- <error 2>

Required JSON schema:
<schema, JSON.stringify with 2-space indent>

Respond again with ONLY a single JSON value that satisfies the schema.
Do not include any prose, explanation, or Markdown code fences.
```

The ` "<name>"` suffix appears only when the trigger carried a name. When the error list is empty the placeholder line `- output was not valid JSON` is used. OpenAI (`buildRetryMessages`) and Anthropic (`buildRetryMessagesAnthropic`) variants produce the same content; both emit plain-string message content (accepted by both APIs).

### 16.11 Success response shapes

The delivered assistant content is the **canonical serialization of the coerced value** (`JSON.stringify`, no pretty-printing) — not the model's raw text. Synthetic ids use the form `axion-pv-<uuid>`. Usage/token counts are zeroed (the Worker does not aggregate usage across attempts).

**OpenAI shape** (`200`, `Content-Type: application/json`):

```json
{
  "id": "axion-pv-<uuid>",
  "object": "chat.completion",
  "created": <unix seconds>,
  "model": "<model from request, or \"unknown\">",
  "choices": [
    { "index": 0,
      "message": { "role": "assistant", "content": "<coerced JSON string>" },
      "finish_reason": "stop" }
  ],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

**Anthropic shape** (`200`, `Content-Type: application/json`):

```json
{
  "id": "axion-pv-<uuid>",
  "type": "message",
  "role": "assistant",
  "model": "<model from request, or \"unknown\">",
  "content": [ { "type": "text", "text": "<coerced JSON string>" } ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": { "input_tokens": 0, "output_tokens": 0 }
}
```

Both carry `x-axion-session`.

### 16.12 Failure response (422)

After 3 failed attempts:

```json
{
  "error": {
    "message": "PolyVerdict: output failed schema validation after retries",
    "errors": [ "<violation 1>", "…" ],
    "attempts": 3
  }
}
```

Status `422`, `Content-Type: application/json`, `x-axion-session` set. The `errors` list is from the **last** attempt.

### 16.13 Interaction with Lens

Lens runs on the **delivered** text: the coerced JSON string on success, the last raw assistant text on 422. Beliefs recorded for enforce sessions therefore reflect what the caller actually received.

### 16.14 Reusable driver — `runEnforceLoop`

`enforce.ts` also exports a transport-agnostic loop driver for tests and embedders:

```typescript
runEnforceLoop(messages, schema, callUpstream, opts?): Promise<EnforceLoopResult>
// opts: { name?, maxAttempts? (clamped to [1, 3]), buildRetry? }
// EnforceLoopResult: EnforceResult & { attempts: number; finalText: string }
```

The Worker uses its own inline loop (it needs upstream-error passthrough); the driver is the reference implementation of the retry policy. All PolyVerdict functions are pure — no `fetch`, no globals.

---

## 17. Dashboard

A single-page React app with **no build step**: React 18 UMD from `unpkg.com` via `<script>` tags, `React.createElement` (no JSX), hand-written CSS. Files: `src/dashboard/index.html`, `app.js`, `styles.css`.

### 17.1 Serving

Served through the `ASSETS` static binding (`wrangler.toml [assets] directory = "./src/dashboard"`):

- `GET /dashboard` and `GET /dashboard/` → `/index.html`.
- `GET /dashboard/<path>` → the prefix is stripped and `<path>` is served from the assets directory (e.g. `/dashboard/styles.css` → `styles.css`). An empty remainder falls back to `/index.html`.
- The assets also happen to be reachable at their root paths (`/app.js`, `/styles.css`) because `index.html` references them absolutely; the canonical entry is `/dashboard`.

The dashboard page requires internet access for the React CDN. **The proxy itself does not.**

### 17.2 Session selection UX (BUILD-SPEC D4)

- A text input (placeholder: `Paste session id (x-axion-session)`) plus a **Load** button (disabled while the input is blank). Submitting the form loads the session.
- **Prefill precedence on mount:** `?session=` query parameter (trimmed) → `localStorage` key `axion.sessionId`. When an initial id resolves, it is persisted and auto-loaded.
- Every successful Load persists the id to `localStorage`. `localStorage` failures (private mode) are non-fatal and silent.
- There is **no session list** — discovery is paste-an-id, by design (no `/api/sessions`).

### 17.3 Data loading

`GET /api/beliefs/<encodeURIComponent(sessionId)>`; the app reads `data.beliefs || []`. While in flight, an empty-state shows `Loading beliefs...`. Fetch errors silently end the loading state (the previous list remains).

### 17.4 Stats bar

Rendered only when at least one belief is loaded:

- **Total Beliefs** — count.
- **Avg Confidence** — mean of numeric confidences, 2 decimal places; `-` when no belief has a numeric confidence.
- One stat per belief type present, using the type labels below.

### 17.5 Filters

Rendered only when at least one belief is loaded. All filters compose (AND):

| Filter | Control | Semantics |
|---|---|---|
| Type | select: All / Causal / Assumption / Intention / Evidence | exact `type` match |
| Min Confidence | number input, 0–1, step 0.1 | hide beliefs with numeric `confidence <` threshold; non-numeric parse falls back to 0 |
| Low confidence only | checkbox | keep only beliefs with numeric `confidence < 0.4`. Labelled **"Low confidence"**, never "wrong" — no invalidation claim (BUILD-SPEC D6) |

Beliefs lacking a numeric `confidence` pass the Min Confidence filter and fail the Low-confidence-only filter.

### 17.6 Belief card

Each belief renders as a card with:

- a type badge (label + color) and a timestamp (`HH:MM:SS`, 24-hour);
- the belief text;
- optional `Evidence: <text>` and `Action: <text>` rows;
- a confidence bar (width = `confidence × 100 %`) plus the numeric value to 2 decimals — rendered **only** when `typeof confidence === 'number'` (defensive guard).

Visual constants:

| Type | Label | Color |
|---|---|---|
| `causal` | Causal | `#3b82f6` (blue) |
| `assumption` | Assumption | `#eab308` (yellow) |
| `intention` | Intention | `#22c55e` (green) |
| `evidence` | Evidence | `#a855f7` (purple) |

Confidence level thresholds (bar styling): `high` ≥ 0.7, `mid` ≥ 0.4, else `low`.

### 17.7 Empty states

| Condition | Message |
|---|---|
| loading | `Loading beliefs...` |
| beliefs loaded, none match filters | `No beliefs match the current filters.` |
| no beliefs at all | `No beliefs yet. Point an agent at this proxy to start capturing.` |

Footer: `LatticeAG — Agents, together.` linking to the GitHub repository.

---

## 18. Error handling matrix

All Worker-generated JSON errors use the shape `{ "error": { "message": string, …extras } }` with `Content-Type: application/json`.

| Status | Origin | Condition | Body / notes | `x-axion-session`? |
|---|---|---|---|---|
| 302 | router | `GET /` | redirect to `/dashboard` | no |
| 400 | proxy | request body is not valid JSON | `Invalid JSON request body` | no |
| 400 | proxy | `messages` missing/empty | `Request must include a non-empty 'messages' array` | no |
| 400 | beliefs API | empty session id in path | `Missing session ID in path` (+ CORS `*`) | no |
| 401 | auth | no caller credential and no server key | `Provide Authorization or x-api-key, or configure UPSTREAM_API_KEY` | no |
| 404 | router | unmatched route/method | plain text `Not Found` | no |
| 404 | Durable Object | unknown internal DO route | plain text `Not Found` (internal only) | — |
| 422 | enforce | schema validation failed after 3 attempts | `message`, `errors[]`, `attempts: 3` | **yes** |
| 4xx/5xx | upstream | upstream returned non-OK | upstream body/headers passed through verbatim | **yes** |
| 502 | proxy | upstream fetch threw | `Failed to reach upstream model API: <detail>` | no |
| 502 | beliefs API | DO fetch threw | `Failed to reach session state: <detail>` (+ CORS `*`) | no |

Failure classes that are **swallowed, never surfaced** (G3): extraction-branch stream read errors, `extractBeliefs` throws, DO store failures, `localStorage` failures in the dashboard.

---

## 19. Configuration and deployment

### 19.1 `wrangler.toml`

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

### 19.2 Environment and bindings (`Env`)

| Name | Kind | Required | Default | Description |
|---|---|---|---|---|
| `UPSTREAM_API_URL` | var | no | `https://api.openai.com` | Upstream base URL; the adapter path is appended. Trailing slashes are stripped. One upstream per deployment — both routes go to the same base, so an Anthropic deployment sets this to `https://api.anthropic.com`. |
| `UPSTREAM_API_KEY` | secret | no | none | Server-side key, used **only** when the caller sends no credential. Set via `wrangler secret put UPSTREAM_API_KEY` (deployed) or `.dev.vars` (local). |
| `SESSION` | Durable Object namespace | yes | — | Per-session state ([§14](#14-session-state-layer-durable-object)). |
| `ASSETS` | static assets fetcher | yes | — | Dashboard files ([§17.1](#171-serving)). |

### 19.3 Local development

Requires Node.js 20+.

```bash
npm install
cp .dev.vars.example .dev.vars   # optional: set UPSTREAM_API_KEY
npm run dev                      # wrangler dev → http://localhost:8787
export OPENAI_BASE_URL=http://localhost:8787      # OpenAI-compatible agents
export ANTHROPIC_BASE_URL=http://localhost:8787   # Anthropic Messages clients
# send x-axion-session: <id> on agent requests
# dashboard: http://localhost:8787/dashboard?session=<id>
```

### 19.4 Deployment

`npx wrangler deploy` (or `npm run deploy`). The DO migration `v1` creates the `SessionDurableObject` class on first deploy. `npm run tail` streams production logs.

### 19.5 Toolchain

- **TypeScript** strict mode (`strict`, `noUnusedLocals`, `noUnusedParameters`), ES2022 target/module, bundler resolution, `@cloudflare/workers-types`, `noEmit` (wrangler bundles).
- **Vitest** with `globals: true`, node environment, `src/**/*.test.ts`.
- **Scripts:** `dev`, `deploy`, `typecheck` (`tsc --noEmit`), `test` (`vitest run`), `check` (`tsc --noEmit && vitest run`), `tail`.

---

## 20. Security model

### 20.1 Design posture (Phase 1)

Axion Phase 1 is built for **local/single-operator deployments**. It intentionally ships without endpoint authentication, rate limiting, or multi-tenancy. Operators handling sensitive data MUST put the Worker behind their own access controls (Cloudflare Access, network policy) until those land.

### 20.2 Threat model

| Asset | Threat | Phase 1 stance |
|---|---|---|
| Belief data | Anyone with a session id can read it — `GET /api/beliefs/:id` has **no auth** and permissive CORS | The session id is a **capability URL**. Use unguessable ids; don't paste them into public places. Empty and nonexistent sessions are indistinguishable (no existence oracle). |
| Upstream API keys | Leakage via the proxy | Keys are forwarded upstream only, never logged, stored, or echoed. `Bearer undefined` is impossible (G6). |
| `UPSTREAM_API_KEY` deployments | Open relay: anyone who can reach the Worker can spend the key | Documented; operators MUST restrict reachability when setting the server key. |
| Worker availability / cost | No rate limiting on any endpoint | Known gap, future work ([SECURITY.md](./SECURITY.md)). |
| Storage | Unbounded per-session growth | Known gap ([§14.4](#144-known-limitation--unbounded-growth), [§22.1](#221-storage-growth)). |
| Prompt/response content | Raw assistant text is persisted per batch (`rawText`) | Disclosed: belief storage includes response text. Session data lives in the operator's own Cloudflare account. |
| Dashboard supply chain | React loaded from `unpkg.com` CDN | Disclosed; the proxy itself has zero runtime dependencies and no CDN exposure. |

### 20.3 Reporting

Vulnerabilities are reported privately via GitHub Security Advisories ([SECURITY.md](./SECURITY.md)). No bug bounty.

---

## 21. Performance and latency

| Stage | Observe path | Enforce path |
|---|---|---|
| Request forwarding | one upstream round trip | one round trip **per attempt** (≤ 3) |
| Response to caller | streamed as it arrives; **no buffering** | fully buffered; returned after validation |
| Belief extraction | `waitUntil`, after delivery; regex-only, sub-millisecond for typical responses | same, on delivered text |
| Added caller latency | effectively zero (tee + header copy) | validation cost + up to 2 extra model calls |

Normative: the observe path MUST NOT introduce buffering on the caller branch. Enforce mode's buffering and retries are by design and documented to callers.

Extraction cost scales with `patterns × text length` (13 regex passes plus an 80-char-window marker scan per match). This is background CPU inside `waitUntil` and does not affect the caller.

---

## 22. Limits and constraints

### 22.1 Storage growth

Beliefs append forever; nothing trims, expires, or compacts ([§14.4](#144-known-limitation--unbounded-growth)). All batches for a session sit under one storage key, so the platform's per-value limit (128 KiB) bounds a session's total history; overflowing writes fail and are swallowed/logged (the proxy is unaffected, but new beliefs for that session stop persisting). Mitigation: rotate session ids per run.

### 22.2 Numeric constants (single source of truth)

| Constant | Value | Where | Meaning |
|---|---|---|---|
| `MAX_ENFORCE_ATTEMPTS` | 3 | `polyverdict/enforce.ts` | total enforce attempts (initial + retries) |
| `CONFIDENCE_MIN` / `CONFIDENCE_MAX` | 0.1 / 1.0 | `lens/patterns.ts` | confidence clamp |
| `DEFAULT_CONFIDENCE` | 0.7 | `lens/patterns.ts` | nominal midpoint (not used at runtime; every pattern has a baseline) |
| `MARKER_SCAN_RADIUS` | 80 | `lens/patterns.ts` | chars scanned each side of a match for markers |
| `DEFAULT_ANTHROPIC_VERSION` | `2023-06-01` | `proxy/auth.ts` | fallback `anthropic-version` |
| capture length bounds | 2–120 (2–140 `error-says`; 2–100 `if-then` condition) | `lens/patterns.ts` | belief clause length |
| low-confidence threshold | 0.4 | dashboard | "Low confidence only" filter and bar level |
| session storage key | `axion.sessionId` | dashboard | `localStorage` |

### 22.3 Known behavioral constraints

- **Header allowlist:** only the headers in [§6.4](#64-headers-sent-upstream) go upstream. Clients relying on `anthropic-beta` or other custom headers will find them dropped.
- **Two API shapes only:** agents work only if they speak OpenAI Chat Completions or Anthropic Messages. Other endpoints of those platforms (embeddings, images, `/v1/responses`) are not routed and 404.
- **One upstream per deployment:** both provider routes share `UPSTREAM_API_URL`.
- **Session correlation is opt-in:** without `x-axion-session`, each request lands under a fresh UUID.
- **Enforce ignores client streaming:** enforce responses are always non-streaming JSON.
- **Extraction is heuristic:** see [§12.6](#126-accuracy-caveats-normative-disclosure).
- **Dashboard needs the internet** for the React CDN; the proxy does not.
- **No rate limiting** anywhere.
- **Tool-call and non-text content is invisible** to the lens in Phase 1 (text deltas only).

---

## 23. Observability

Phase 1 observability is Cloudflare-native:

- **Logging:** `console.error` on swallowed failures, all prefixed `axion:` — `belief extraction failed`, `failed to store beliefs in DO` (with DO status and body), `DO store threw`. Viewable via `wrangler tail` / the dashboard. No key material is ever logged.
- **No metrics endpoint, no tracing, no structured log schema** in Phase 1.
- The `x-axion-session` response header doubles as the correlation handle between an agent run and its stored data.

---

## 24. Testing and CI

### 24.1 Test suite

Vitest, colocated `*.test.ts` files, unit tests at the seams:

| File | Covers |
|---|---|
| `src/proxy/auth.test.ts` | passthrough precedence, server key, neither → 401, no-`Bearer undefined` invariant |
| `src/proxy/content.test.ts` | OpenAI + Anthropic non-stream and SSE text extraction |
| `src/proxy/stream.test.ts` | SSE record parsing, multi-line data, tee accumulation, decoder flush |
| `src/lens/extract.test.ts` | `because` / `because of`, sessionId stamping, confidence clamp, evidence field |
| `src/state/SessionDurableObject.test.ts`, `sessionBeliefs.test.ts` | batch append + flatten shape, session-name resolution |
| `src/polyverdict/schema.test.ts` | validate / invalidate / coerce matrix |

Design-for-testability rules: pure helpers extracted from runtime glue (`sessionBeliefs.ts`, all of `polyverdict/`), injectable `uuid`/`now` in the lens, transport-injected `runEnforceLoop`.

### 24.2 CI

GitHub Actions (`.github/workflows/ci.yml`): on every PR and push to `main`, Node 20, `npm ci`, `npm run check` (typecheck + full suite). A green `check` is the merge gate.

---

## 25. Compatibility and versioning

- **Public surface** (stable within Phase 1): the two proxy routes and their observe/enforce semantics; `x-axion-session` request/response header; `x-axion-schema` header; `GET /api/beliefs/:sessionId` and its `{ sessionId, beliefs[] }` shape; the `ExtractedBelief` field set; the error shapes in [§18](#18-error-handling-matrix).
- **Additive changes** (new optional fields, new routes, new patterns) MAY ship in minor versions. Renaming/removing fields, changing confidence semantics, or changing route behavior are breaking and require a major version and a spec update.
- **Internal surface** (no stability promise): DO internal routes and storage schema, module layout, pattern regex internals, dashboard markup.
- The `@planned` graph types are explicitly not API; they may change or disappear without notice.

---

## 26. Planned layers (not implemented)

Everything in this section is **design intent with no runtime**. Nothing here may be presented as shipped. Sequencing rationale lives in [PLAN.md](./PLAN.md); the locked non-goals in BUILD-SPEC still apply to the current build.

### 26.1 Prerequisites recap

| Planned piece | Blocked on |
|---|---|
| Belief graph / root-cause | justified edges + failure signals (an outcome source) |
| Axion Loop | stable multi-turn sessions (shipped: `x-axion-session`) + an embedding/similarity step |
| Axion Gate | plan extraction + a request-intercept/verdict path |
| Semantic PolyVerdict | proven syntax path + per-field budget controls |

### 26.2 Axion Loop (planned)

**Goal:** detect when an agent is cycling the same reasoning and intervene with targeted feedback instead of a hard kill.

Planned design sketch (non-normative):

- **Detection:** maintain a rolling window of recent belief embeddings per session. A revision loop is N (default 3) consecutive responses whose belief sets exceed a cosine-similarity threshold (default 0.92) against the window, with no new `evidence`-type beliefs between them.
- **Intervention:** on detection, inject a system-side hint into the next proxied request (e.g. "You have proposed substantially the same approach 3 times; state what new information would change your approach, or try a different one."). Injection MUST be visible in an audit record and capped (max 1 intervention per M turns) so the middleware never becomes an invisible actor.
- **Surface:** new per-session endpoint (e.g. `GET /api/loops/:sessionId`) listing detected loops with the belief ids involved; dashboard badge on looped spans.
- **Constraints to honor:** observe-path latency guarantee (embedding work stays in `waitUntil`; intervention decisions read *prior* state only), G3 (failures must not break the proxy), and explicit opt-in (a header or config flag; Loop MUST never trigger on a vanilla deployment).

### 26.3 Axion Gate (planned)

**Goal:** verify tool calls before they run; block bad ones.

Planned design sketch (non-normative):

- **Interception point:** tool calls appear inside model *responses* (OpenAI `tool_calls`, Anthropic `tool_use` blocks). Gate would parse them on the extraction branch and, in enforce-style mode, buffer the response to render a verdict *before* the agent sees the tool call.
- **Checks:** plan alignment (does the call match stated intentions in the session timeline?), contradiction (does it act against a high-confidence recent belief?), known failure patterns (per-tool deny/warn rules).
- **Verdicts:** `allow` (pass through), `warn` (pass through + annotate session), `block` (replace the tool call with a synthetic tool-error the agent can react to). Blocking MUST be opt-in, auditable, and reversible per rule.
- **Relationship to PolyVerdict:** PolyVerdict is Gate-shaped (validate → retry → block) but scoped to response format; Gate generalizes the pattern to tool-call semantics.

### 26.4 Belief graph (planned)

Upgrade the flat timeline to a DAG using the already-declared types ([§13.3](#133-planned-graph-types-planned-no-runtime)): edges (`derived` / `contradicts` / `supports`) justified by textual proximity and shared referents; `invalidated` set post-hoc from failure signals; root-cause = walk from a failure-adjacent belief up its `parentIds`. Requires per-batch storage keys (the single-key layout in [§14.2](#142-storage-schema) does not scale to graphs) and new read routes. Explicitly out of scope until edges can be *justified*, not just guessed.

### 26.5 PolyVerdict future work (planned)

- **Semantic verification:** opt-in, budget-capped per-field checks by a second model (`x-axion-verify: semantic`), off by default; never on the syntax path.
- **Schema registry DO:** named schemas (`x-axion-schema-name`), keyed separately from session state.
- **Hash cache:** skip upstream when an identical schema + prompt already passed (keyed on a content hash).
- **Wider JSON Schema coverage:** `format`, `pattern`, numeric bounds, `additionalProperties`, `minLength`/`maxLength` — each keyword added to [§16.5](#165-json-schema-subset) is a documented spec change.
- **Streaming enforce:** would require incremental validation; deliberately unplanned until a sound design exists.

### 26.6 Hosted SaaS (out of the OSS core)

Multi-session dashboard, cross-session analysis, team sharing/alerting, community pattern library. The OSS core stays: proxy, extraction, per-session DO store, single-session dashboard, opt-in syntax enforce.

---

## 27. Appendix A: header reference

### 27.1 Request headers read by Axion

| Header | Read by | Purpose |
|---|---|---|
| `Authorization` | auth | caller credential (highest precedence) |
| `x-api-key` | auth | caller credential, Anthropic style |
| `anthropic-version` | auth | forwarded on the Anthropic path; defaulted when absent |
| `OpenAI-Organization` | auth | forwarded when present |
| `x-axion-session` | proxy | session correlation id ([§8](#8-session-model)) |
| `x-axion-schema` | PolyVerdict | inline JSON Schema enforce trigger ([§16.1](#161-trigger-detection)) |

All other request headers are ignored and **not** forwarded upstream.

### 27.2 Response headers set by Axion

| Header | Where | Value |
|---|---|---|
| `x-axion-session` | all proxied responses + enforce 422 | the resolved session id |
| `Content-Type` | Worker-generated responses | `application/json` (errors, enforce results, beliefs API) |
| `Access-Control-Allow-Origin` | beliefs API only | `*` |

---

## 28. Appendix B: worked examples

### 28.1 Observe, streaming (OpenAI)

```bash
curl -N http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "x-axion-session: run-42" \
  -H "content-type: application/json" \
  -d '{"model":"gpt-4o-mini","stream":true,
       "messages":[{"role":"user","content":"Why did the deploy fail?"}]}'
```

The caller receives the upstream SSE bytes untouched, plus `x-axion-session: run-42`. If the assistant says *"The deploy failed because the migration lockfile is stale. I'll regenerate it."*, the background pass stores two beliefs under `run-42`: a `causal` (belief "the migration lockfile is stale", baseline 0.85) and an `intention` (belief "regenerate it", baseline 0.75).

### 28.2 Reading the timeline

```bash
curl http://localhost:8787/api/beliefs/run-42
# → { "sessionId": "run-42", "beliefs": [ …ExtractedBelief, chronological… ] }
```

Dashboard equivalent: `http://localhost:8787/dashboard?session=run-42`.

### 28.3 Enforce via header (OpenAI)

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H 'x-axion-schema: {"type":"object","properties":{"score":{"type":"number"}},"required":["score"]}' \
  -H "content-type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Rate this 1-10 as JSON."}]}'
```

Model returns ` ```json {"score": "8"} ``` ` → fences stripped, `"8"` coerced to `8`, response is an OpenAI-shaped 200 whose assistant content is `{"score":8}`. Had the model omitted `score` three times, the caller would get `422` with `["$: missing required property \"score\""]`.

### 28.4 Enforce via body (Anthropic)

```bash
curl http://localhost:8787/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4-5","max_tokens":256,
       "response_format":{"type":"json_schema","json_schema":{"name":"verdict",
         "schema":{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}}},
       "messages":[{"role":"user","content":"Is 2+2=4? Answer as JSON."}]}'
```

`response_format` is consumed by Axion (stripped upstream); the reply is an Anthropic-shaped `message` whose single text block is the coerced JSON.

### 28.5 Fail-closed auth

```bash
curl -s http://localhost:8787/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"messages":[{"role":"user","content":"hi"}]}'
# → 401 {"error":{"message":"Provide Authorization or x-api-key, or configure UPSTREAM_API_KEY"}}
```

(assuming no `UPSTREAM_API_KEY` is configured.)

---

## 29. Document history

- **1.0.0** — Complete rewrite. Replaced the previous high-level overview with a full normative specification: routing and lifecycle contracts, the auth algorithm and header allowlist, tee/SSE/decoding rules, the exact pattern registry and confidence algorithm with worked examples, the storage schema and its limits, the full PolyVerdict trigger/loop/schema/coercion/retry/response contract, the dashboard behavior spec, a complete error matrix, security threat model, numeric-constants table, compatibility policy, and detailed planned-layer designs (Loop, Gate, graph, semantic PolyVerdict). Prior drafts: see [PLAN.md](./PLAN.md) for how the current state was reached; [BUILD-SPEC.md](./BUILD-SPEC.md) remains the locked product-decision record; [SPEC-PolyVerdict.md](./SPEC-PolyVerdict.md) and [TECHNICAL.md](./TECHNICAL.md) remain as focused companions and defer to this document.
