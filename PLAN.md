# Axion + PolyVerdict — production readiness plan

> Plan only. Do not implement from this doc until the build order below is accepted.
> Scope: open-source Phase 1 (Axion Lens) shippable on Cloudflare Workers, plus an honest sequencing decision for PolyVerdict.

---

## Verdict

The proxy hot path is the strongest part of the repo: tee the response, return it immediately, extract in `waitUntil`. That part is close to real infrastructure.

What is not shippable is the product around it. The dashboard cannot list or render beliefs. Auth is an open relay if you put a secret in the Worker. Docs sell a belief DAG, Anthropic drop-in, and key passthrough that the code does not provide. PolyVerdict is a proposal with zero code, and its retry/block model fights Lens’s zero-latency observe path.

For OSS, the first job is to make Phase 1 true: a working OpenAI-compatible observe proxy, a durable per-session belief timeline, a dashboard that shows it, and docs that match. PolyVerdict comes after that, as an opt-in enforce mode, not as default Lens middleware.

---

## What exists today

```
Agent → POST /v1/chat/completions
      → Worker tees body (ReadableStream.tee)
      → caller gets upstream stream immediately
      → waitUntil → regex extract → DO append batch
      → dashboard tries /api/sessions (404) and expects flat beliefs (gets nested batches)
```

| Piece | Status |
|---|---|
| OpenAI chat proxy + SSE tee | Real |
| `waitUntil` belief extraction | Real (quality thin) |
| Session DO storage | Real append log via Durable Object storage |
| Belief DAG / root-cause | Types only |
| Dashboard | UI exists; API contract broken |
| Anthropic `/v1/messages` | Not implemented |
| Caller key passthrough | Documented, not implemented |
| PolyVerdict | `SPEC-PolyVerdict.md` only |
| `npm test` / CI | Vitest dep present; no test script; one stream test file |

---

## Decisions to lock before build

These are product calls. Wrong defaults will force rework.

### D1. Auth model (pick one)

| Option | Meaning | Fit |
|---|---|---|
| **A. Passthrough (recommended for OSS)** | Forward caller `Authorization` / `x-api-key`. Worker holds no model key. Fail closed if neither caller key nor optional server key is present. | Matches “point agent at Axion” and avoids an open credit relay. |
| **B. Server key + proxy token** | Worker holds `UPSTREAM_API_KEY`. Every call requires an Axion token. | Better for a hosted SaaS later; heavier for self-host OSS. |

Default for this plan: **A**, with optional server key as fallback only when explicitly configured.

### D2. Phase 1 data model honesty

Ship a **flat chronological belief timeline**, not a DAG.

Keep Durable Objects as the session owner. Persist ordered events (already closer to storage than the “in-memory Map, lost on eviction” story). Defer `parentIds` / edges / root-cause until extract or a post-pass can justify links.

Delete or clearly mark unused `BeliefDAG` / edge APIs as planned. Do not advertise root-cause until it exists.

### D3. Provider scope for Phase 1

Phase 1 ships **OpenAI-compatible `/v1/chat/completions` only**.

Anthropic Messages becomes Phase 1.1 behind a provider adapter. Remove Claude Code / `ANTHROPIC_BASE_URL` claims from README until that adapter lands.

### D4. PolyVerdict placement

PolyVerdict is Gate-shaped: validate, retry, coerce, possibly block. Lens is observe-shaped: never delay the agent.

Same Worker package later is fine. Same default request path is not. Sequence PolyVerdict as an **opt-in enforce mode** after Lens contracts are honest, behind a provider/content adapter, with its own latency budget.

---

## Build waves (ordered)

### Wave 0 — Truth and safety (merge before any feature work)

Make the repo honest and non-dangerous.

1. **Auth boundary**
   - Implement D1 (passthrough + fail closed).
   - Align `Env` typing, `wrangler.toml` comments, README Quick Start, and `TECHNICAL.md`.
   - Add `.dev.vars.example` with `UPSTREAM_API_URL` / optional `UPSTREAM_API_KEY`.

2. **Docs vs code**
   - Rewrite README / SPEC Phase 1 status to: OpenAI chat proxy + regex timeline + DO session store + local dashboard.
   - Move DAG, root-cause, NLP, Anthropic, key passthrough (once implemented, keep), `/api/sessions` (until built), Loop, Gate, PolyVerdict to explicit Planned sections.
   - Fix Known Issues: DO uses Durable Object storage (survives eviction); unbounded growth is the real risk.

3. **OSS hygiene floor**
   - Add `"test": "vitest run"` (and keep `typecheck`).
   - Minimal GitHub Actions: typecheck + test on PR.
   - Stub `CONTRIBUTING.md` + `SECURITY.md` (how to report, that beliefs API is unauthenticated in Phase 1).

**Exit:** A stranger can deploy without becoming an open model-key proxy, and the README does not lie.

---

### Wave 1 — Make Lens usable end-to-end

This is the actual Phase 1 product.

4. **Canonical session identity**
   - Pass `{ sessionId }` into `extractBeliefs` from `runExtraction`.
   - Document that agents must send `x-axion-session` for multi-turn correlation (or document a fallback “latest” single-session mode for local demo).
   - DO GET returns the human session name (the `idFromName` key), never the opaque DO id as the user-facing id.

5. **Beliefs API contract**
   - Public shape: `{ sessionId: string, beliefs: ExtractedBelief[] }` chronological flatten of batches.
   - Keep raw batches internal if useful for debugging; do not leak them to the dashboard.
   - Treat this JSON as a typed boundary shared by DO → Worker → dashboard.

6. **Session discovery**
   - Either:
     - **6a.** Add a small session registry (KV or registry DO write-on-first-use) + `GET /api/sessions`, or
     - **6b.** Drop the dropdown and make the dashboard Phase 1 “single session”: paste / read `x-axion-session` (matches SPEC’s “local single-session dashboard” better).
   - Recommendation: **6b for OSS MVP**, **6a when multi-session is real**. SPEC already says multi-session is SaaS-later; the UI overreached.

7. **Dashboard wire-up**
   - Consume flattened beliefs.
   - Session UX per 6b or 6a.
   - Redefine or remove “wrong beliefs only” until `invalidated` exists (today it is `confidence < 0.4`).
   - Confirm Workers Assets serve `/app.js` and `/styles.css` (or route them explicitly).

8. **Content normalization before extract**
   - Streaming: keep OpenAI delta concat (already).
   - Non-streaming: parse `choices[0].message.content` (and refuse to scan raw JSON envelopes).
   - Isolate behind a small `extractAssistantText(responseMode, bytes)` helper so Anthropic can plug in later.

**Exit:** Point an OpenAI-compatible agent at the Worker with a stable `x-axion-session`, open the dashboard, see a real timeline.

---

### Wave 2 — Extraction quality and contracts

Worth doing once the pipes work; do not block Wave 1 on perfect linguistics.

9. **Pattern / confidence honesty**
   - Fix `because of` group capture.
   - Either populate `evidence` via `evidenceGroup` or stop claiming the field.
   - Pick one confidence formula and document it (prefer documented additive modifiers for readability, or update docs to midpoint bands — do not leave both).
   - Pass real `sessionId`; stop random per-belief ids.

10. **Tests at the seams**
    - Lens: pattern fixtures (because / because of / intention nesting / no-punctuation).
    - Extraction glue: session stamp + content parse for stream and non-stream.
    - DO round-trip: store batches → public flatten shape.
    - Auth matrix: passthrough vs server key vs neither (fail closed).
    - Router: no silent 404 for whatever session UX Wave 1 chose.

**Exit:** Regressions in the dashboard contract or auth fail CI.

---

### Wave 3 — Provider adapter (Phase 1.1)

11. **Adapter boundary**
    - Interface covering: route match, auth header map, stream event parse, assistant text extract.
    - OpenAI adapter = current behavior.
    - Anthropic Messages adapter = new route + SSE shape.
    - Then restore README Claude Code / Hermes claims with tested instructions.

**Exit:** At least one non-OpenAI agent path is real, or docs stay OpenAI-only.

---

### Wave 4 — PolyVerdict (after Lens is honest)

Do not start until Waves 0–1 are done and Wave 2 tests exist. Prefer Wave 3 adapter first so schema enforcement is not OpenAI-only forever.

12. **PolyVerdict as opt-in enforce mode**
    - Trigger: `x-schema` / `response_format` JSON Schema (draft 2020-12).
    - Control flow: hold → validate → retry upstream (max 3) with violation hints → optional coerce → return.
    - Explicitly **not** the Lens tee path. New code path that may add latency; success criteria keep `<200ms` for syntax-only pass, zero extra latency only when schema passes first try (meaning: validate after full body for non-stream, or buffered validate for stream — decide and document; do not pretend tee + mutate is free).
    - Schema registry DO (named schemas) as a separate binding from session beliefs.
    - Hash cache for identical schema+prompt skip.
    - Semantic / PolyGnosis verification stays opt-in and budget-capped (Phase later inside PolyVerdict).

13. **Composition with Lens**
    - When enforce mode is on: validate first, then Lens extracts from the **delivered** (possibly coerced) text.
    - When off: today’s observe path unchanged.
    - Same package, mode switch — not a silent middleware wrap of every request.

**Exit:** Schema-gated chat completions work on OpenAI path with tests for pass / fail-retry / coerce; Lens still observes.

---

### Explicitly later (do not sneak into OSS Phase 1)

| Item | Why later |
|---|---|
| Belief DAG + root-cause | Needs justified edges and failure signals |
| Axion Loop | Needs stable multi-turn sessions + embeddings |
| Axion Gate (tool-call block) | Needs plan extraction + intervene path |
| Hosted multi-session SaaS | Out of OSS core per SPEC |
| Langfuse / Arize export | Easy after flat JSON is stable |
| Semantic PolyVerdict | Costly; after syntax path |

---

## Priority matrix

| Priority | Fix | Wave |
|---|---|---|
| P0 | Auth fail-closed + passthrough (or token gate) | 0 |
| P0 | Docs truth-align (no DAG / Anthropic / passthrough lies) | 0 |
| P0 | Flatten beliefs API + dashboard session UX | 1 |
| P0 | Stamp `sessionId` on extract | 1 |
| P0 | Non-stream content parse before extract | 1 |
| P1 | `npm test` + CI + env example | 0–2 |
| P1 | Pattern / evidence / confidence honesty | 2 |
| P1 | OpenAI-only README until adapter exists | 0 / 3 |
| P2 | Anthropic adapter | 3 |
| P2 | CONTRIBUTING / SECURITY | 0 |
| P3 | PolyVerdict enforce mode | 4 |
| P3 | DAG / Loop / Gate | later |

---

## Architecture sketch after Waves 0–1

```
Agent (OpenAI-compatible, x-axion-session)
  ↕
Axion Worker
  ├── Auth: passthrough or configured server key (fail closed)
  ├── POST /v1/chat/completions  → upstream → tee → waitUntil extract
  ├── GET  /api/beliefs/:sessionId → flat ExtractedBelief[]
  ├── Dashboard: paste/select session → timeline
  └── SessionDurableObject: durable ordered belief batches (internal)
```

After Wave 4 (optional):

```
  ├── Observe mode (default): tee + Lens
  └── Enforce mode (x-schema): validate/retry/coerce → then Lens on delivered text
```

---

## Suggested first build PR sequence (when we exit plan mode)

1. `fix(auth+docs): fail-closed passthrough + honest README/SPEC`
2. `fix(api): flatten beliefs + session UX + stamp sessionId`
3. `fix(extract): non-stream content parse + because-of / evidence`
4. `chore(ci): vitest script + GH Actions`
5. (optional) `feat(providers): Anthropic messages adapter`
6. (later) `feat(polyverdict): opt-in schema enforce mode`

Do not combine 1–3 with PolyVerdict in one PR.

---

## Open questions for the next turn

Answer these when we leave plan mode; defaults above apply if silent:

1. Auth: confirm **passthrough (A)** vs **server key + token (B)**.
2. Dashboard: confirm **paste session id (6b)** vs **registry + `/api/sessions` (6a)**.
3. Is PolyVerdict in the first production OSS tag at all, or clearly “proposal / Phase 2 enforce”?
4. Keep unused DAG types with `@planned` comments, or delete until needed?

---

## References

- Product: `SPEC.md`, `TECHNICAL.md`, `README.md`
- PolyVerdict proposal: `SPEC-PolyVerdict.md`
- Runtime: `src/proxy/*`, `src/lens/*`, `src/state/SessionDurableObject.ts`, `src/dashboard/*`
)
