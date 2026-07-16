# Axion + PolyVerdict: production readiness plan

> **Status:** decisions locked; Waves 0 through 4 (syntax path) implemented. This file is now a record of how the current state was reached, not an open plan.
> **Source of truth for scope:** [BUILD-SPEC.md](./BUILD-SPEC.md). The locked decisions there supersede the "decisions to lock" section below. Where this file and BUILD-SPEC disagree, BUILD-SPEC wins.

---

## Where things stand

The plan below was written against an earlier repo where the docs oversold the code. That gap is closed. The decisions were locked in [BUILD-SPEC.md](./BUILD-SPEC.md) and the build was carried out. Current state:

| Piece | Status |
|---|---|
| OpenAI chat proxy + SSE tee | Implemented |
| Anthropic `/v1/messages` proxy | Implemented |
| Passthrough auth + fail-closed 401 | Implemented (`src/proxy/auth.ts`) |
| `waitUntil` belief extraction, sessionId stamped | Implemented |
| DO session store, flat `GET /api/beliefs/:id` | Implemented (append batches, flatten on read) |
| Dashboard paste-session UX + low-confidence filter | Implemented |
| Additive confidence, clamp `[0.1, 1.0]`, because-of / evidence | Implemented |
| PolyVerdict enforce (syntax validate + coerce + retry <=3) | Implemented, opt-in |
| Vitest suite + `npm run check` + GitHub Actions | Implemented |
| `.dev.vars.example`, `CONTRIBUTING`, `SECURITY` | Present |
| Belief DAG / root-cause | Not built (types only, `@planned`) |
| `/api/sessions` registry | Not built (by decision) |
| Axion Loop / Gate | Not built |
| Semantic PolyVerdict / schema registry DO | Not built |

---

## Decisions (locked)

These were open product calls. They are now locked in [BUILD-SPEC.md](./BUILD-SPEC.md). Recorded here for context.

### D1: auth model. Locked: passthrough first.

Forward the caller's `Authorization` or `x-api-key`. Use `UPSTREAM_API_KEY` only when it is set. Fail closed with 401 otherwise. No `Bearer undefined`. This matches "point your agent at Axion" and avoids an open model-key relay.

### D2: Phase 1 data model. Locked: flat chronological timeline.

The Durable Object owns the session and appends ordered batches to DO storage. The public API flattens them to `{ sessionId, beliefs: ExtractedBelief[] }`. `BeliefNode` / `BeliefDAG` types stay marked `@planned`; no graph API is built.

### D3: provider scope. Locked: OpenAI + Anthropic.

Both `POST /v1/chat/completions` and `POST /v1/messages` ship behind a shared provider adapter. This resolves the earlier plan's "OpenAI-only until an adapter lands" hedge: the adapter landed.

### D4: PolyVerdict placement. Locked: opt-in enforce mode, separate path.

Same Worker, different code path. It runs only on a schema trigger and buffers by design. It is never a silent wrap of the observe path.

---

## Build waves (as executed)

### Wave 0: truth and safety. Done.

- Passthrough auth implemented and fail-closed.
- Docs rewritten to match code (this pass): no DAG, no root-cause, no `/api/sessions`, no Anthropic claim without the route.
- `npm test` / `npm run check`, GitHub Actions, `.dev.vars.example`, `CONTRIBUTING.md`, `SECURITY.md` added.

### Wave 1: Lens usable end-to-end. Done.

- `{ sessionId }` passed into `extractBeliefs`; `x-axion-session` correlates a run and is echoed on every response.
- Public beliefs shape is the flat `{ sessionId, beliefs }` boundary shared by DO, Worker, and dashboard.
- Session discovery is paste-a-session-id (option 6b), not a registry. The dashboard consumes the flat list; the "wrong" filter became "low confidence only" (`confidence < 0.4`).
- Non-streaming bodies are parsed to assistant text before extraction; raw JSON is never scanned.

### Wave 2: extraction quality and tests. Done.

- `because of` capture fixed (split from bare `because`). Evidence patterns populate the `evidence` field.
- One documented confidence formula: additive markers, clamp `[0.1, 1.0]`.
- Tests at the seams: auth matrix, content parse (stream + non-stream, both providers), lens fixtures, DO flatten, schema validate/coerce.

### Wave 3: provider adapter. Done.

- `ProviderAdapter` interface with OpenAI and Anthropic adapters. Anthropic SSE parses `content_block_delta` text deltas. Docs restore the Anthropic base-URL instructions because the route now exists.

### Wave 4: PolyVerdict enforce. Syntax path done.

- Trigger on `x-axion-schema` or `response_format.json_schema`. Buffered enforce loop: validate, coerce, retry <=3 with violation hints, 422 on exhaustion. Lens runs on delivered text.
- Not the tee path. Enforce forces non-streaming.
- Semantic verification, schema registry DO, and hash cache are deferred.

---

## Deferred (not in the current build)

| Item | Why deferred |
|---|---|
| Belief DAG + root-cause | Needs justified edges and failure signals |
| Axion Loop | Needs stable multi-turn sessions + embeddings |
| Axion Gate | Needs plan extraction + an intervene path |
| Semantic PolyVerdict | Costly; comes after the syntax path proves out |
| Schema registry DO, hash cache | Optimisations, not needed for correctness |
| Hosted multi-session SaaS | Out of the OSS core per SPEC |
| Langfuse / Arize export | Straightforward once the flat JSON is stable |

---

## Open questions (resolved)

The plan's original open questions, with their locked answers:

1. Auth: passthrough (A). Locked.
2. Dashboard: paste session id (6b). Locked.
3. PolyVerdict in the first OSS tag: yes, as opt-in syntax enforce. Semantic stays future.
4. Unused DAG types: kept with `@planned` comments, not deleted.

---

## References

- Locked scope: [BUILD-SPEC.md](./BUILD-SPEC.md)
- Product: [SPEC.md](./SPEC.md), [TECHNICAL.md](./TECHNICAL.md), [README.md](./README.md)
- PolyVerdict: [SPEC-PolyVerdict.md](./SPEC-PolyVerdict.md)
- Runtime: `src/proxy/*`, `src/lens/*`, `src/polyverdict/*`, `src/state/*`, `src/dashboard/*`
