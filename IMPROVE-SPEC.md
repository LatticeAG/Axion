# IMPROVE-SPEC — Axion + PolyVerdict polish pass

> Additive to BUILD-SPEC.md. Decisions in BUILD-SPEC stay locked.
> Goal: make every shipped surface sharper, safer, and more pleasant to use.

---

## Locked improvements

### I1. Proxy ops surface
- `GET /health` → `{ ok: true, service: "axion", version: "0.2.0" }`
- `OPTIONS` on `/api/beliefs/*`, `/v1/chat/completions`, `/v1/messages` with CORS allow headers
- Shared CORS helper: `Access-Control-Allow-Origin: *`, allow methods GET/POST/DELETE/OPTIONS, allow headers `authorization, content-type, x-api-key, anthropic-version, x-axion-session, x-axion-schema, openai-organization`
- Request body size guard: reject > 2MB with 413 before parsing

### I2. Beliefs API richness
- `GET /api/beliefs/:id` response adds:
  ```json
  {
    "sessionId": "...",
    "beliefs": [...],
    "meta": { "count": N, "batchCount": B, "lastUpdated": ms|null }
  }
  ```
- `DELETE /api/beliefs/:id` → clears session storage; `{ ok: true }`
- Keep flat beliefs array

### I3. DO retention
- Cap stored batches at **200** (drop oldest on overflow)
- Export `MAX_BELIEF_BATCHES = 200` from sessionBeliefs
- On GET include meta fields above
- Unit tests for cap + meta

### I4. Lens quality
- Tighten `from-the` to require a following clause signal (comma/then/verb-ish) — reduce “from the start” false positives
- Add patterns:
  - `so that X` → intention/causal (label so-that, type intention, capture X)
  - `which means X` / `this means X` → causal
  - `looking at X` / `given that X` → evidence / assumption
  - `my plan is to X` → intention
- Deduplicate exact duplicate belief strings within a single extract call (keep first, higher precedence already)
- Expand extract tests for new patterns + false-positive regression

### I5. Dashboard UX (keep black mono aesthetic)
- Header shows active session id + **Copy** button
- **Auto-refresh** toggle (default on when session loaded): poll every 4s
- **Export JSON** button → download `axion-<session>.json`
- **Clear session** button → DELETE + confirm via `window.confirm`
- Expandable raw text on BeliefCard (click belief → toggle `rawText`)
- Empty states: no session / loading / empty / filter-miss (distinct copy)
- Subtle motion: fade-in timeline cards, pulse on refresh (CSS only, 2–3 motions)
- Atmosphere: soft radial gradient on bg (not flat pure black), keep monochrome

### I6. PolyVerdict v1.1
- Support `x-axion-schema: @name` when schema was previously registered
- Schema registry: same SESSION DO OR new methods on SessionDurableObject under `/schemas`:
  - Prefer **new** Durable Object `SchemaRegistryDurableObject` bound as `SCHEMAS` (clean separation)
  - `PUT /api/schemas/:name` body = JSON Schema
  - `GET /api/schemas/:name`
  - `DELETE /api/schemas/:name`
  - Header `x-axion-schema: @my-schema` resolves via registry
- In-memory request hash cache on Worker isolate: `sha256(schemaJson + assistantAttempt0)` skip re-validate if identical (document: best-effort, not durable)
- Add `additionalProperties: false` support in schema subset
- Add `minLength` / `maxLength` / `minimum` / `maximum` for strings/numbers
- Tests for registry + new keywords + named schema trigger

### I7. Observability
- Structured logs (single-line JSON) for: extraction complete `{event, sessionId, beliefCount, ms}`, enforce result `{event, ok, attempts, errorCount}`
- Helper `src/proxy/log.ts` — `logInfo(event, fields)`

### I8. Examples + package bump
- `examples/curl-openai.sh`, `examples/curl-anthropic.sh`, `examples/curl-polyverdict.sh`
- Bump `package.json` version to `0.2.0`
- README: short “What’s new in 0.2” + examples pointer

### I9. Tests
- `src/proxy/index.routing.test.ts` — health, OPTIONS, 413 oversized (mock fetch where needed; unit-test helpers rather than full worker if CF env hard)
- Prefer testing pure helpers extracted for size limit / cors / health
- All existing tests must keep passing

---

## Non-goals (still)

- Belief DAG / Loop / Gate tool interception
- Semantic second-model PolyVerdict
- Multi-session registry listing
- Hosted SaaS

---

## File ownership for parallel build

| Agent | Owns |
|---|---|
| A Proxy ops | `cors.ts`, `log.ts`, health/OPTIONS/413 in `index.ts`, size guard helper, routing tests |
| B State+API | DO cap/meta/DELETE, beliefs.ts routes, sessionBeliefs helpers+tests, Schema DO + wrangler.toml binding |
| C Lens | patterns + extract dedupe + tests |
| D Dashboard | app.js + styles.css + index.html if fonts |
| E PolyVerdict | schema keywords, named trigger, hash cache helper, tests; wire detectSchemaTrigger async resolve |
| F Docs/examples | examples/*, README 0.2 section, SPEC/TECHNICAL deltas, IMPROVE-SPEC link |

Wave order: A/C/D can start immediately. B Schema DO + E PolyVerdict after wrangler binding. Integrator merges index wiring for schemas + DELETE.
