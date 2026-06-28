<div align="center">

# Axion

Agent cognitive middleware — a proxy layer that inspects, detects,
and verifies agent reasoning in real time.

**by LatticeAG**

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-f38020?logo=cloudflare&logoColor=white&labelColor=black)](https://workers.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178c6?logo=typescript&logoColor=white&labelColor=black)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg?logo=opensourceinitiative&logoColor=white)](./LICENSE)
[![Open Source](https://img.shields.io/badge/Open-Source-black.svg?logo=github&logoColor=white)](https://github.com/mosesman831)

</div>

---

## What It Does

Axion sits between an AI agent and the outside world. It intercepts model
responses, agent outputs, and tool calls — then makes agent reasoning
**visible**, **diagnosable**, and **verifiable** as it happens.

Named after the axion particle: theorized to exist, never directly
observed, detected only through its effects. Agent beliefs are the same —
invisible, but they shape every decision. Axion makes them visible.

```
                      ┌─────────────────────────────────────────┐
                      │                  Axion                   │
                      │              (CF Worker proxy)            │
                      │                                         │
   Agent  ←─ HTTP ─→  │  ┌──────────┐  ┌──────────┐  ┌────────┐  │  ──→  Model API
                      │  │   Lens   │  │   Loop   │  │  Gate  │  │  ──→  Tools
                      │  │ observe  │  │  detect  │  │  block │  │
                      │  └────┬─────┘  └────┬─────┘  └───┬────┘  │
                      │       └───── belief graph ───────┘       │
                      │            (Durable Object)              │
                      └─────────────────────────────────────────┘
                                          │
                                          ▼
                              dashboard  /  timeline
```

## Quick Start

Requires Node.js and a Cloudflare account.

```bash
# 1. Clone
git clone https://github.com/mosesman831/axion.git
cd axion

# 2. Install
npm install

# 3. Run locally (Wrangler dev server)
npm run dev
# → http://localhost:8787

# 4. Point any base_url-aware agent at Axion
export ANTHROPIC_BASE_URL=http://localhost:8787
export OPENAI_BASE_URL=http://localhost:8787

# 5. Open the dashboard
# → http://localhost:8787/dashboard
```

To deploy your own instance:

```bash
npx wrangler deploy
# → https://your-axion-worker.dev
```

## The Three Layers

| Layer | Name | Phase | What it does |
|:---:|---|---|---|
| 1 | **Axion Lens** | observe | Belief inspection — extracts the agent's reasoning chain, assumptions, and confidence from each response. Builds a belief DAG across the session. |
| 2 | **Axion Loop** | detect | Revision loop breaker — embeds agent outputs, detects when an agent is stuck cycling the same reasoning, and intervenes with targeted feedback instead of a crude kill signal. |
| 3 | **Axion Gate** | block | Runtime verification — intercepts tool calls before execution, checks plan alignment, contradiction, and failure patterns, then blocks or allows. |

> Lens is read-only and cannot break anything. It ships first and powers
> the other two: Loop uses the belief graph, Gate uses the belief graph
> plus the stated plan.

## Integration

Axion works with any agent that supports `base_url` override. Zero code
changes — set the environment variable and the agent runs normally.

```bash
# Claude Code
export ANTHROPIC_BASE_URL=https://your-axion-worker.dev

# Codex / OpenAI-compatible agents
export OPENAI_BASE_URL=https://your-axion-worker.dev
```

```yaml
# Hermes — config.yaml
providers:
  anthropic:
    base_url: https://your-axion-worker.dev
```

```
# Cursor
# Settings → Models → set "Custom API base URL"
# → https://your-axion-worker.dev
```

Axion observes in the background. The agent behaves exactly as before —
except every decision now has a visible, traceable belief behind it.

## Tech Stack

- **Runtime** — Cloudflare Workers (edge proxy, zero cold start)
- **State** — Durable Objects (per-session belief graph, in memory)
- **Extraction** — Rule-based parser (regex + lightweight NLP), no model dependency, <1ms
- **Dashboard** — served from Worker static assets
- **External dependencies** — zero in the open-source core

## Roadmap

| Phase | Layer | Status | Ships |
|:---:|---|:---:|---|
| 1 | **Axion Lens** | in progress | proxy + belief extraction + local dashboard |
| 2 | **Axion Loop** | planned | embedding detection + intervention injection |
| 3 | **Axion Gate** | planned | tool-call interception + verification + blocking |

**Phase 1 open-source scope:** the proxy, the belief extraction engine,
session state, and a local single-session dashboard. A hosted multi-session
SaaS dashboard (cross-session analysis, team sharing, alerting) comes later.

See [SPEC.md](./SPEC.md) for the full architecture and build plan.

## Project Structure

```
axion/
├── src/
│   ├── proxy/        CF Worker: stream proxy + interception
│   ├── lens/         belief extraction engine
│   ├── state/        Durable Object: session belief graph
│   └── dashboard/    belief timeline UI
├── SPEC.md
├── wrangler.toml
└── package.json
```

## License

MIT — see [LICENSE](./LICENSE).

---

<div align="center">

**LatticeAG** — *Agents, together.*

[github.com/mosesman831](https://github.com/mosesman831)

</div>
