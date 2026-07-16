# Axion

> Agent cognitive middleware. A proxy that reads an agent's reasoning from its own model output.
> Open-source core. The vision is three layers; today one of them ships.

> **Source of truth for scope:** [BUILD-SPEC.md](./BUILD-SPEC.md). All product decisions there are locked. This file keeps the brand and architecture at a high level. Where the two disagree, BUILD-SPEC wins.

---

## What it is

Axion is a proxy between an AI agent and a model API. Override the agent's base URL and Axion forwards each request upstream, streams the response back with zero added latency, then parses the assistant text for reasoning fragments and stores them per session. Any agent that supports a `base_url` override works, with no code changes.

```
Agent  <->  Axion  <->  Model API
```

## The problem

Agents make decisions you cannot see. Observability tools show what an agent did (the calls, the tokens, the latency). They do not show the reasoning behind a choice. Axion extracts that reasoning as it streams past and lays it out as a per-session timeline you can read after the fact.

The longer-term goal is to act on that reasoning: catch loops, block bad tool calls. Those layers are not built. See status below.

---

## The three layers

### Layer 1: Axion Lens (belief inspection)

**Status: shipping (observe path).** Read-only. Cannot change agent behaviour.

Intercepts each model response and extracts reasoning fragments (causal claims, assumptions, intentions, cited evidence) with a confidence score, then stores them as a flat chronological timeline per session. A local dashboard reads the timeline back.

- Rule-based regex parsing, no model call, sub-millisecond.
- Emits `ExtractedBelief` records: `{ id, sessionId, type, belief, evidence?, confidence, actionTaken?, timestamp, rawText, line }`.
- Confidence is a per-pattern baseline nudged by additive markers, clamped to `[0.1, 1.0]`.
- Stored in a Durable Object as append-only batches; the public API flattens them.

There is no belief graph and no root-cause backtracking. Those were in earlier drafts and are not implemented.

### Layer 2: Axion Loop (revision loop breaker)

**Status: planned. Not implemented.**

The intent is to detect when an agent repeats the same reasoning and inject targeted feedback instead of a hard kill. This needs stable multi-turn sessions and an embedding step, neither of which exists yet.

### Layer 3: Axion Gate (runtime verification)

**Status: planned. Not implemented.**

The intent is to check tool calls before they run (plan alignment, contradiction, known failure patterns) and block bad ones. No tool-call interception exists in the code.

### PolyVerdict (structured output enforce)

**Status: partial. Syntax path shipped, opt-in.**

A separate enforce path in the same Worker. When a caller supplies a JSON Schema it validates and type-coerces the model output and retries up to 3 times. It is not part of the default observe path and only runs when a schema is present. See [SPEC-PolyVerdict.md](./SPEC-PolyVerdict.md).

---

## Architecture

```
Agent
  |
Axion Worker (Cloudflare)
  |- Auth: passthrough caller key, or configured server key, else 401
  |- POST /v1/chat/completions   OpenAI adapter    -> observe or enforce
  |- POST /v1/messages           Anthropic adapter  -> observe or enforce
  |- GET  /api/beliefs/:id        flat ExtractedBelief[]
  |- GET  /dashboard              paste-session timeline UI
  |
Model API

State: SessionDurableObject, one per session, append-only belief batches in DO storage.
```

## Build order and status

| Phase | What | Status |
|---|---|---|
| 1 | Axion Lens: OpenAI + Anthropic observe proxy, belief timeline, DO store, dashboard | **Shipped** |
| 1 | PolyVerdict enforce mode (syntax validate + coerce + retry), opt-in | **Shipped** |
| 2 | Axion Loop: loop detection + intervention | Planned, not started |
| 3 | Axion Gate: tool-call interception + verification + blocking | Planned, not started |
| later | Semantic PolyVerdict, schema registry, belief graph, hosted SaaS | Not started |

The locked build order and module map are in [BUILD-SPEC.md](./BUILD-SPEC.md). [PLAN.md](./PLAN.md) records how the current state was reached and what is deferred.

## Open-source scope (Phase 1)

This repo is the open-source core:

- CF Worker proxy for OpenAI chat completions and Anthropic Messages, zero added latency.
- Rule-based belief extraction.
- Per-session Durable Object store.
- Local single-session dashboard.
- Opt-in PolyVerdict syntax enforce mode.

Not in the open-source core (possible SaaS later):

- Hosted multi-session dashboard.
- Cross-session analysis.
- Team sharing and alerting.
- Community pattern library.

## Tech stack

- **Runtime:** Cloudflare Workers.
- **State:** Durable Objects (per-session append-only storage).
- **Extraction:** regex rules, no model dependency.
- **Dashboard:** React from CDN, served as static assets from the Worker.
- **Runtime dependencies:** none.

## Integration

```bash
# OpenAI-compatible agents
export OPENAI_BASE_URL=https://your-axion-worker.dev

# Anthropic Messages clients (e.g. Claude Code)
export ANTHROPIC_BASE_URL=https://your-axion-worker.dev
```

Send `x-axion-session: <id>` to correlate a multi-turn run, then open the dashboard at `https://your-axion-worker.dev/dashboard` and paste the id. Only these two provider routes are implemented; other agents work only if they speak one of these two API shapes.

---

## Brand

**Axion** is a particle theorized to exist but never directly observed, detected only through its effects. Agent beliefs are the same. They are invisible but they drive every decision.

**LatticeAG** - Agents, together.

```
axion/
|- BUILD-SPEC.md   <- locked scope, source of truth
|- SPEC.md         <- this file
|- README.md
|- TECHNICAL.md
|- SPEC-PolyVerdict.md
|- PLAN.md
|- src/
|  |- proxy/       CF Worker: routing, auth, tee, providers, enforce wiring
|  |- lens/        belief extraction engine
|  |- polyverdict/ schema validate + coerce + retry
|  |- state/       Durable Object session store
|  |- dashboard/   React timeline UI
|- wrangler.toml
|- package.json
```
