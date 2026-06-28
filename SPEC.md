# Axion

> Agent cognitive middleware - a proxy layer that inspects, detects, and verifies agent reasoning.
> Open-source core. Hosted SaaS dashboard later.

---

## What It Is

Axion is a proxy that sits between an AI agent and the outside world. It intercepts model responses, agent outputs, and tool calls - then inspects, detects, and verifies agent reasoning in real time.

Any agent that supports `base_url` override works. Zero code changes.

```
Agent ←→ Axion ←→ Model API
Agent ←→ Axion ←→ Tools (file, shell, API)
```

## What Problem It Solves

Agents make decisions developers can't understand, get stuck in loops they can't break, and take actions they can't verify. Existing tools show **what** happened (observability). Axion shows **why** it happened, **when** it's going wrong, and **stops** it before damage is done.

---

## The Three Layers

### Layer 1 - Axion Lens (belief inspection)
**Observe. Read-only. Cannot break anything.**

Intercepts model responses and extracts the agent's beliefs, assumptions, and reasoning chain. Builds a belief DAG across the session. When something goes wrong, you trace back to the exact belief that caused the wrong action.

- Extracts `{belief, evidence, confidence, action_taken}` from each model response
- Rule-based parsing (regex + NLP), not model-based - fast and cheap
- Builds a belief graph: beliefs → decisions → outcomes
- Backtracks from failures to root-cause beliefs
- Serves a timeline dashboard: every decision point, beliefs behind it, confidence, correct/wrong
- Feeds into existing observability tools (Langfuse, Arize) as structured metadata

**This is the MVP. Ships first.**

### Layer 2 - Axion Loop (revision loop breaker)
**Detect + intervene. Uses belief graph from Layer 1.**

Detects when an agent is stuck in a revision loop and intervenes with targeted feedback - not a crude kill signal.

- Embeds each agent output, maintains sliding window of last 10-20 outputs
- If cosine similarity exceeds threshold (0.85), flags potential loop
- Classifies: productive iteration vs stuck loop vs thrashing (uses belief graph)
- Injects targeted feedback: "You've tried [X] 3 times with the same result. Consider: [alternatives not yet tried]."
- Escalation ladder: soft nudge → hard nudge (force re-read task) → escalate to human

### Layer 3 - Axion Gate (runtime self-verification)
**Block + correct. Uses belief graph + plan from Layer 1.**

Verification gate that checks agent actions **before** they execute. Not post-hoc evals - real-time blocking with corrections fed back to the agent.

- Intercepts tool calls (file writes, shell, API) before execution
- Three checks per call:
  - **Plan alignment:** does this action match the stated plan?
  - **Contradiction detection:** does this contradict a prior decision?
  - **Pattern matching:** does this match a known failure anti-pattern?
- Blocks bad actions, injects correction: "Blocked: you decided to use customer_uuid in step 3 but are writing user_id."
- Uses cheap flash models via OpenCode Zen for verification (target: <500ms, <$0.001 per check)
- Logs every blocked action as training data for the rules engine

---

## Architecture

```
Agent
  ↕
Axion Proxy (CF Worker)
  ├── Axion Lens    → intercepts model responses → extracts beliefs → waitUntil()
  ├── Axion Loop    → intercepts agent outputs → embeds → detects loops
  └── Axion Gate    → intercepts tool calls → verifies → blocks/allows
  ↕
Model API / Tools

State: Durable Object per session (belief DAG in memory)
```

## Build Order

| Phase | What | Status |
|---|---|---|
| 1 | Axion Lens - proxy + belief extraction + local dashboard | **Next** |
| 2 | Axion Loop - embedding detection + intervention injection | Future |
| 3 | Axion Gate - tool call interception + verification + blocking | Future |

## Open-Source Scope (Phase 1)

This repo contains the open-source core:

- CF Worker proxy (streams model responses, zero added latency)
- Belief extraction engine (rule-based parser)
- Session state (Durable Object)
- Local dashboard (single session, served by Worker)

**Not in open-source core (SaaS later):**
- Hosted multi-session dashboard
- Cross-session belief analysis
- Team sharing + alerting
- Community belief pattern library

## Tech Stack

- **Runtime:** Cloudflare Workers
- **Session state:** Durable Objects
- **Extraction:** Rule-based (regex + lightweight NLP), no model dependency
- **Dashboard:** React, served from Worker static assets
- **Zero external dependencies** for the open-source core

## Integration

```bash
# Claude Code
export ANTHROPIC_BASE_URL=https://your-axion-worker.dev

# Codex / OpenAI agents
export OPENAI_BASE_URL=https://your-axion-worker.dev

# Cursor - set custom API base URL in settings
# Hermes - set provider base_url in config.yaml
```

Agent works normally. Axion observes in the background. Dashboard at `https://your-axion-worker.dev/dashboard`.

---

## Brand

**Axion** - a particle theorized to exist but never directly observed. Agent beliefs are the same: invisible, but they shape every decision. Axion makes them visible.

**LatticeAG** - *"Agents, together."*

```
axion/
├── SPEC.md          ← this file
├── README.md
├── src/
│   ├── proxy/        ← CF Worker: stream proxy + interception
│   ├── lens/         ← belief extraction engine
│   ├── state/        ← Durable Object: session belief graph
│   └── dashboard/    ← React: belief timeline
├── wrangler.toml
└── package.json
```
