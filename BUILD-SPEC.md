# BUILD-SPEC — Axion + PolyVerdict (locked, ready to build)

> All product decisions are locked below. Implement exactly this. Do not reopen auth/dashboard/provider/PolyVerdict placement questions.
> Supersedes open questions in `PLAN.md`.

---

## Locked decisions

| ID | Choice |
|---|---|
| D1 Auth | **Passthrough first.** Forward caller `Authorization` or Anthropic `x-api-key` (+ `anthropic-version`). If caller has no key and `UPSTREAM_API_KEY` secret is set, use the secret. If neither → **401** with clear JSON error. Never send `Bearer undefined`. |
| D2 Data model | **Flat chronological timeline.** DO stores batches internally; public API returns `{ sessionId, beliefs: ExtractedBelief[] }`. Keep `BeliefNode`/`BeliefDAG` types marked `@planned` in comments only — do not implement graph APIs. |
| D3 Providers | **OpenAI chat completions + Anthropic Messages** in this build. Shared provider adapter. |
| D4 Dashboard | **Paste / enter session id** (no `/api/sessions`, no registry). Prefill from `?session=` query or `localStorage`. Show copy hint for `x-axion-session`. |
| D5 Confidence | **Documented additive modifiers**, clamp `[0.1, 1.0]`. Update code to match README (not midpoint bands). |
| D6 “Wrong” filter | Rename UI to **Low confidence** (`confidence < 0.4`). Do not claim invalidation. |
| D7 PolyVerdict | **Opt-in enforce mode** in same Worker when `x-axion-schema` header or `response_format.type === "json_schema"` is present. Separate code path (may buffer). Default requests stay zero-latency tee. |
| D8 Scope of PolyVerdict v1 | Syntax validate + type coerce (string↔number↔boolean) + retry ≤3 with violation hints. No semantic/second-model verify. No schema-registry DO yet (inline schema / header JSON only). No LexGateway. |

---

## Target architecture

```
POST /v1/chat/completions     → OpenAI adapter → observe OR enforce
POST /v1/messages             → Anthropic adapter → observe OR enforce

Observe (default):
  upstream → tee → caller
  waitUntil → normalizeAssistantText → extractBeliefs({sessionId}) → DO

Enforce (x-axion-schema | response_format.json_schema):
  loop ≤3: upstream (non-stream forced for enforce) → parse JSON → validate/coerce
  on fail: retry with schema + violation hint appended to messages
  on success: return coerced JSON as OpenAI/Anthropic-shaped response
  waitUntil Lens on delivered assistant text

GET  /api/beliefs/:sessionId  → flat ExtractedBelief[]
GET  /dashboard               → paste session id UI
```

---

## Module map (create / change)

| Path | Action |
|---|---|
| `src/proxy/auth.ts` | **New** — resolveUpstreamAuth(request, env) → Headers patch or 401 |
| `src/proxy/providers/types.ts` | **New** — ProviderAdapter interface |
| `src/proxy/providers/openai.ts` | **New** — chat completions route, SSE delta, non-stream content |
| `src/proxy/providers/anthropic.ts` | **New** — `/v1/messages`, SSE `content_block_delta`, non-stream content |
| `src/proxy/providers/index.ts` | **New** — matchProvider(pathname) |
| `src/proxy/content.ts` | **New** — extractAssistantText({ isSse, provider, rawAccumulated }) |
| `src/proxy/index.ts` | **Rewrite routing** — providers, auth, enforce branch |
| `src/proxy/stream.ts` | Flush TextDecoder; keep tee; export helpers for Anthropic SSE parse |
| `src/proxy/extraction.ts` | Pass `{ sessionId }` into extractBeliefs |
| `src/proxy/beliefs.ts` | Expect flat shape from DO (or flatten here) |
| `src/proxy/types.ts` | `UPSTREAM_API_KEY?: string`; optional PolyVerdict flags |
| `src/state/SessionDurableObject.ts` | Store `sessionName`; GET flattens + returns human sessionId |
| `src/lens/patterns.ts` | Fix because-of; evidenceGroup on evidence patterns; punctuation optional where safe |
| `src/lens/extract.ts` | Additive confidence + clamp [0.1,1.0] |
| `src/polyverdict/schema.ts` | **New** — minimal JSON Schema subset validator + coerce |
| `src/polyverdict/enforce.ts` | **New** — retry loop, hint injection |
| `src/dashboard/app.js` | Paste session UX; low-confidence rename |
| `package.json` | `test` script |
| `.github/workflows/ci.yml` | typecheck + test |
| `.dev.vars.example`, `CONTRIBUTING.md`, `SECURITY.md` | New |
| `README.md`, `SPEC.md`, `TECHNICAL.md`, `SPEC-PolyVerdict.md`, `PLAN.md` | Truth-align |

---

## Detailed requirements

### 1. Auth (`src/proxy/auth.ts`)

```
resolveUpstreamCredentials(request, env):
  callerAuth = Authorization header (trim)
  callerAnthropicKey = x-api-key
  serverKey = env.UPSTREAM_API_KEY?.trim()

  if callerAuth: use it (forward as-is)
  else if callerAnthropicKey: forward x-api-key + anthropic-version (default 2023-06-01 if missing)
  else if serverKey: Authorization: Bearer ${serverKey}
  else: throw AuthError 401 "Provide Authorization or x-api-key, or configure UPSTREAM_API_KEY"

Also forward: OpenAI-Organization, anthropic-version (when Anthropic path), content-type.
```

### 2. Provider adapters

**OpenAI**
- Route: `POST /v1/chat/completions`
- Validate: non-empty `messages[]`
- Upstream path: `/v1/chat/completions`
- Stream text: `choices[0].delta.content`
- Non-stream text: `choices[0].message.content` (string or join text parts)

**Anthropic**
- Route: `POST /v1/messages`
- Validate: non-empty `messages[]` (Anthropic shape)
- Upstream path: `/v1/messages`
- Stream text: SSE events where `type === "content_block_delta"` and `delta.type === "text_delta"` → `delta.text`
- Non-stream text: join `content[]` blocks with `type === "text"` → `.text`
- Headers: `x-api-key`, `anthropic-version`, `content-type`

### 3. Stream / content

- Always `decoder.decode(value, { stream: true })` then final `decoder.decode()` flush.
- For SSE: parse provider-specific deltas into assistant text for extraction.
- For non-SSE: **never** feed raw JSON to lens — parse via provider adapter.

### 4. Session + DO

- Proxy sessionId from `x-axion-session` or UUID; echo header always.
- `extractBeliefs(text, { sessionId })`.
- DO storage key `"beliefs"` remains batch array; also store `"sessionName"` on first write.
- `GET /beliefs` response:
  ```json
  {
    "sessionId": "<human name from idFromName / stored sessionName>",
    "beliefs": [ /* ExtractedBelief flattened chronological */ ]
  }
  ```
- Flatten: concatenate each batch’s `beliefs` in storage order.
- Remove “STUB” header; document as Phase 1 timeline store.

### 5. Lens patterns / confidence

- Split `because of` and `because` into two patterns OR use group resolution that accepts group 1 or 2.
- Evidence patterns: set `evidenceGroup: 1` and put a short claim in `belief` (e.g. label `"cited evidence"` or the capture duplicated into both belief + evidence — prefer `belief` = capture, `evidence` = capture for evidence-type for dashboard usefulness).
- Confidence: scan markers; apply additive deltas from README:
  - definitely/certainly/absolutely: +0.2
  - probably/likely: +0.1
  - might/could be/possibly: −0.2
  - not sure/uncertain/unsure: −0.3
  - clamp to [0.1, 1.0]
- Soften trailing punctuation requirement: allow end-of-string as clause end.

### 6. Dashboard

- Replace session `<select>` with text input + Load button.
- `localStorage` key `axion.sessionId`.
- On mount: `?session=` query → input; else localStorage.
- Filters: type, min confidence, “Low confidence only” (not “wrong”).
- BeliefCard: guard `typeof belief.confidence === 'number'`.

### 7. PolyVerdict v1 (`src/polyverdict/*`)

**Trigger** (either):
- Header `x-axion-schema: <json-schema-json>` (URL-decoded if needed), or
- Body `response_format: { type: "json_schema", json_schema: { name?, schema, strict? } }` (OpenAI style)

**Behavior:**
- Force non-streaming upstream for enforce path (if client asked stream, still return non-stream JSON completion shaped for that provider — document this; simpler and correct for schema).
- Extract assistant text → strip markdown fences → `JSON.parse`.
- Validate with **minimal subset**: `type`, `properties`, `required`, `items`, `enum`, nested objects/arrays. Unknown keywords ignored.
- Coerce: string `"42"` → number if schema says number; `"true"`/`"false"` → boolean; number → string if schema says string.
- On failure: append user/system hint message with violation list; retry up to 3 total attempts.
- On success: return provider-shaped response with coerced JSON string as assistant content; run Lens waitUntil on that text.
- If no schema trigger: never enter this path.

### 8. Tests (must pass)

| File | Covers |
|---|---|
| `src/proxy/auth.test.ts` | passthrough, server key, neither→401, no Bearer undefined |
| `src/proxy/content.test.ts` | OpenAI non-stream JSON → content; Anthropic non-stream; SSE openai; SSE anthropic |
| `src/lens/extract.test.ts` | because of; sessionId stamp; confidence clamps; evidence field |
| `src/state/SessionDurableObject.test.ts` | store + flatten GET (mock storage or unit flatten helper) |
| `src/polyverdict/schema.test.ts` | valid/invalid/coerce |
| Keep `src/proxy/stream.test.ts` | existing |

### 9. Docs / OSS hygiene

- README: OpenAI + Anthropic real instructions; auth model; Phase 1 = timeline not DAG; dashboard paste session; PolyVerdict opt-in header; Known Issues honest.
- SPEC Phase 1 status → Shipping (Lens timeline); link BUILD-SPEC.
- TECHNICAL: match code (tee, auth, DO flatten, routes including `/v1/messages`).
- SPEC-PolyVerdict: status → Partially implemented (syntax path); semantic verify still future.
- `package.json`: `"test": "vitest run"`, `"check": "tsc --noEmit && vitest run"`.
- `.github/workflows/ci.yml`: node 20, npm ci, npm run check.
- `.dev.vars.example`, `CONTRIBUTING.md`, `SECURITY.md` (beliefs API unauthenticated by design in Phase 1 — treat session UUID as capability URL).

---

## Non-goals (do not build)

- Belief DAG / root-cause routes
- `/api/sessions` registry
- Loop / Gate tool interception
- Semantic PolyVerdict / second model
- Schema registry Durable Object
- Hosted multi-session SaaS
- Rate limiting (note in SECURITY as future)

---

## Acceptance checklist

- [ ] `npm run check` passes
- [ ] OpenAI proxy works with caller Bearer key and no worker secret
- [ ] Anthropic `/v1/messages` routed and text extracted for Lens
- [ ] Dashboard loads beliefs by pasted session id
- [ ] `GET /api/beliefs/:id` returns flat `ExtractedBelief[]`
- [ ] Enforce mode rejects invalid JSON schema outputs and retries
- [ ] Docs do not claim unimplemented DAG/NLP/passthrough-wrongly
- [ ] No `Bearer undefined` path

---

## Implementation order for agents

Parallel OK within a wave; finish Wave A before depending on it in Wave B.

**Wave A (parallel):** auth.ts + types Env; DO flatten + sessionName; lens patterns/confidence; content.ts + stream flush; package.json test script + ci + hygiene files

**Wave B (parallel):** wire index.ts OpenAI path to auth+content+session stamp; beliefs API; dashboard paste UX; extract.test + auth.test + content.test

**Wave C (parallel):** Anthropic adapter + route; PolyVerdict schema+enforce + wire trigger in index; docs truth-align

**Wave D:** integrate, fix conflicts, `npm run check`, commit
)
