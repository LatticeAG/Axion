<div align="center">

# Axion

Agent cognitive middleware. A proxy that reads what an agent believes from its own model output, in real time, with no code changes to the agent.

**by LatticeAG**

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-f38020?logo=cloudflare&logoColor=white&labelColor=black)](https://workers.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178c6?logo=typescript&logoColor=white&labelColor=black)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg?logo=opensourceinitiative&logoColor=white)](./LICENSE)
[![Open Source](https://img.shields.io/badge/Open-Source-black.svg?logo=github&logoColor=white)](https://github.com/LatticeAG/Axion)

</div>

---

## What this is

Axion is a Cloudflare Worker that sits in front of a model API. Point an agent at it by overriding the base URL. The Worker forwards each request upstream and streams the response straight back with zero added latency. After the response is delivered, it runs a rule-based parser over the assistant text to pull out reasoning fragments (causal claims, assumptions, intentions, cited evidence), stamps them with a confidence score, and stores them per session. A local dashboard reads them back as a timeline.

Named after the axion particle: theorized to exist, never directly observed, detected only through its effects. Agent beliefs are the same. They are invisible but they shape every decision, and this makes them visible.

```
Agent  <->  Axion (CF Worker)  <->  Model API
```

> **Honest scope.** This repo is the Phase 1 observe path plus an opt-in schema enforce mode. It does not detect loops, block tool calls, or build a belief graph. See [What is not built](#what-is-not-built) before you form expectations. The full product plan lives in [BUILD-SPEC.md](./BUILD-SPEC.md), which is the source of truth for scope.

---

## What is shipped

- **OpenAI-compatible proxy.** `POST /v1/chat/completions`, streaming and non-streaming.
- **Anthropic Messages proxy.** `POST /v1/messages`, streaming and non-streaming.
- **Passthrough auth.** Forward the caller's `Authorization` or `x-api-key`. Fall back to the `UPSTREAM_API_KEY` secret only when it is set. Otherwise return 401. No `Bearer undefined` is ever sent upstream.
- **Zero-latency observe path.** The response body is tee'd with `ReadableStream.tee()`. One branch streams to the caller untouched; the other accumulates text for extraction in `waitUntil()` after delivery.
- **Belief extraction.** Regex patterns pull causal/assumption/intention/evidence fragments. Confidence starts at a per-pattern baseline and is nudged by additive markers, clamped to `[0.1, 1.0]`. Every belief is stamped with the session id.
- **Durable session store.** A Durable Object appends each response's beliefs as a batch to Durable Object storage. `GET /api/beliefs/:sessionId` returns a flat chronological `ExtractedBelief[]`.
- **Local dashboard.** Paste or link a session id, see its timeline. Filter by type, minimum confidence, or low-confidence only.
- **PolyVerdict enforce mode (opt-in).** Send a JSON Schema and the Worker validates, coerces types, and retries the model up to 3 times before returning. Off by default.
- **Tests and CI.** Vitest suite, `npm test` / `npm run check`, GitHub Actions on push and PR.

## What is not built

These appear in older drafts and in the roadmap. None of them are in the code:

- Belief DAG, parent/child edges, root-cause backtracking. The store is a flat timeline. `BeliefNode`/`BeliefDAG` types exist but are marked `@planned` and have no runtime.
- `/api/sessions` session registry. The dashboard takes a pasted session id instead.
- Axion Loop (loop detection) and Axion Gate (tool-call blocking).
- Semantic PolyVerdict, second-model verification, hallucination checks.
- Schema registry Durable Object, schema hash cache.
- Hosted multi-session SaaS dashboard.

---

## The three layers

| Layer | Name | Status | What it does |
| :---: | --- | :---: | --- |
| 1 | **Axion Lens** | Shipping (observe) | Extracts reasoning fragments from each response into a per-session timeline. Read-only. |
| 2 | **Axion Loop** | Planned | Detect when an agent is cycling the same reasoning and intervene with feedback. Not implemented. |
| 3 | **Axion Gate** | Planned | Verify tool calls before execution and block bad ones. Not implemented. |

Lens is read-only and cannot change agent behaviour. PolyVerdict enforce mode is a separate opt-in path that does change output (it can retry the model and coerce types), triggered only when the caller supplies a schema.

---

## Architecture

```
Agent (OpenAI- or Anthropic-compatible, sends x-axion-session)
  |
  v
Axion Worker (Cloudflare)
  |- auth.ts       resolve passthrough / server-key credentials, or 401
  |- providers/    match POST /v1/chat/completions or POST /v1/messages
  |- stream.ts     ReadableStream.tee: caller branch + extraction branch
  |- content.ts    normalize SSE deltas / non-stream body to assistant text
  |- extraction.ts waitUntil -> extractBeliefs({ sessionId }) -> DO
  |- polyverdict/  opt-in enforce: validate + coerce + retry <=3
  |
  v
Model API (UPSTREAM_API_URL, default https://api.openai.com)

State: SessionDurableObject appends belief batches to DO storage.
Read:  GET /api/beliefs/:sessionId -> { sessionId, beliefs: ExtractedBelief[] }
UI:    GET /dashboard
```

---

## Quick start

Requires Node.js 20+ and a Cloudflare account for deploy.

```bash
npm install
cp .dev.vars.example .dev.vars   # optional: set UPSTREAM_API_KEY
npm run dev
export OPENAI_BASE_URL=http://localhost:8787
# send header  x-axion-session: my-session  on your agent's requests
# dashboard:   http://localhost:8787/dashboard?session=my-session
npm run check
```

The proxy uses passthrough auth. If your agent already sends its own API key, you do not need `UPSTREAM_API_KEY`. Set it only if you want the Worker to hold the key and let callers omit it.

Anthropic agents route through `POST /v1/messages`:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8787
# Claude Code and other Anthropic Messages clients hit POST /v1/messages
```

Deploy your own instance:

```bash
npx wrangler deploy
# -> https://your-axion-worker.dev
```

---

## Sessions and the dashboard

Beliefs are grouped by session. Send `x-axion-session: <id>` on agent requests to correlate a multi-turn run. If the header is absent the Worker generates a UUID per request and returns it in the `x-axion-session` response header, so a single call is still captured but multi-turn correlation needs the header.

Open `http://localhost:8787/dashboard`, paste the session id, and press Load. The id also reads from `?session=` in the URL and from `localStorage` (`axion.sessionId`).

The beliefs API is unauthenticated in Phase 1. Anyone with a session id can read that session's beliefs. Treat the id like a capability token. See [SECURITY.md](./SECURITY.md).

---

## PolyVerdict enforce mode

Enforce mode is off unless the request carries a schema. Two triggers:

- Header `x-axion-schema: <JSON Schema as JSON>` (URL-decoded if needed), or
- Body `response_format: { "type": "json_schema", "json_schema": { "schema": { ... } } }`.

When triggered, the Worker forces a non-streaming upstream call, parses the assistant JSON (stripping Markdown fences), validates it against the schema, and coerces primitive types (`"42"` to number, `"true"`/`"false"` to boolean, number to string). On a violation it appends the errors as a correction message and retries, up to 3 attempts total. On success it returns a provider-shaped JSON response. After 3 failed attempts it returns HTTP 422 with the violations. Lens still extracts from the delivered text.

The schema subset covers `type`, `properties`, `required`, `items`, `enum`, and nesting. Unknown keywords are ignored. There is no semantic or second-model verification.

Example (OpenAI path):

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "x-axion-schema: {\"type\":\"object\",\"properties\":{\"score\":{\"type\":\"number\"}},\"required\":[\"score\"]}" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Rate this 1-10 as JSON."}]}'
```

---

## Belief extraction

| Type | Trigger phrases | Baseline confidence |
| --- | --- | --- |
| Causal | "because X", "because of X", "since X", "due to X", "as a result of X" | 0.8 to 0.85 |
| Assumption | "assuming X", "presumably X", "I'll assume X", "if X then Y" | 0.6 to 0.65 |
| Intention | "I'll X", "I'm going to X", "let me X", "I should X", "I plan/intend to X" | 0.75 |
| Evidence | "based on X", "according to X", "from the X", "the error says X" | 0.7 to 0.85 |

Confidence starts at the baseline and each marker found near the match adds its delta:

- definitely / certainly / absolutely: +0.2
- probably / likely: +0.1
- might / could be / possibly / may: -0.2
- not sure / uncertain / unsure: -0.3

The result is clamped to `[0.1, 1.0]`. This is a linguistic heuristic, not a truth signal. It reflects how the model hedged, nothing more.

---

## File structure

```
axion/
|- src/
|  |- proxy/
|  |  |- index.ts              Worker entry: routing, observe + enforce branches
|  |  |- auth.ts               passthrough / server-key credential resolution
|  |  |- stream.ts             ReadableStream.tee + SSE parsing (OpenAI + Anthropic)
|  |  |- content.ts            assistant-text normalization per provider
|  |  |- extraction.ts         waitUntil glue to extractBeliefs + DO store
|  |  |- beliefs.ts            GET /api/beliefs/:id -> DO
|  |  |- routes.ts             dashboard static asset handler
|  |  |- providers/            openai + anthropic adapters, matcher, interface
|  |  |- types.ts              Env + proxy request/response types
|  |- lens/
|  |  |- patterns.ts           regex belief patterns + confidence markers
|  |  |- extract.ts            extraction engine (additive confidence, clamp)
|  |  |- types.ts              ExtractedBelief; BeliefNode/BeliefDAG (@planned)
|  |- polyverdict/
|  |  |- schema.ts             JSON Schema subset validator + coercion
|  |  |- enforce.ts            trigger detection, retry loop, hint injection
|  |  |- types.ts              enforce types
|  |- state/
|  |  |- SessionDurableObject.ts   append batches, flatten on GET
|  |  |- sessionBeliefs.ts         pure flatten / sessionId helpers
|  |- dashboard/               React via CDN, no build step
|- BUILD-SPEC.md               locked scope (source of truth)
|- SPEC.md  TECHNICAL.md  SPEC-PolyVerdict.md  PLAN.md
|- wrangler.toml  tsconfig.json  package.json
```

---

## Tech stack

- **Runtime:** Cloudflare Workers.
- **State:** Durable Objects, one per session, backed by Durable Object storage.
- **Extraction:** regex rules only, no model call, sub-millisecond.
- **Dashboard:** React from CDN, no bundler, served as static assets.
- **Runtime dependencies:** none. `wrangler`, `typescript`, and `vitest` are dev-only.

---

## Known issues

- Loop (Phase 2) and Gate (Phase 3) are not implemented.
- The beliefs API is unauthenticated. A session id is a read capability. See [SECURITY.md](./SECURITY.md).
- Session storage is unbounded. Beliefs append to Durable Object storage and are never trimmed. Long-lived session ids will grow without limit. There is no rate limiting yet.
- Extraction is a regex heuristic. It misses reasoning that does not use the trigger phrases and will mis-parse unusual phrasing. Confidence reflects hedging words, not correctness.
- Without an `x-axion-session` header each request lands under a fresh UUID, so multi-turn correlation depends on the caller sending a stable id.
- The dashboard loads React from a CDN and needs internet access for that page. The proxy itself does not.
- Enforce mode always returns non-streaming JSON, even if the client asked to stream. This is intentional so the full payload can be validated.

---

## Links

- **Source:** [github.com/LatticeAG/Axion](https://github.com/LatticeAG/Axion)
- **LatticeAG:** [latticeag.vercel.app](https://latticeag.vercel.app)

## License

MIT. See [LICENSE](./LICENSE).

---

<div align="center">

**LatticeAG** - Agents, together.

</div>
