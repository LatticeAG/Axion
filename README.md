<div align="center">

# Axion

Agent cognitive middleware — inspect, detect, and verify agent reasoning in real time.

**by LatticeAG**

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-f38020?logo=cloudflare&logoColor=white&labelColor=black)](https://workers.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178c6?logo=typescript&logoColor=white&labelColor=black)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg?logo=opensourceinitiative&logoColor=white)](./LICENSE)
[![Open Source](https://img.shields.io/badge/Open-Source-black.svg?logo=github&logoColor=white)](https://github.com/mosesman831)

</div>

---

## Overview

> **Agent cognitive middleware — a proxy layer that makes agent reasoning visible, diagnosable, and verifiable.**
> Observe beliefs. Detect loops. Block bad actions.

Axion sits between an AI agent and the outside world. It intercepts model responses, agent outputs, and tool calls — then reconstructs the agent's decision-making chain in real time. Existing observability tools show *what* happened. Axion shows *why* it happened, *when* it's going wrong, and stops it before damage is done.

Named after the axion particle: theorized to exist, never directly observed, detected only through its effects on surrounding matter. Agent beliefs are the same — invisible, but they shape every decision. Axion makes them visible.

Built for any agent that supports `base_url` override. Zero code changes.

```
Agent ←→ Axion (CF Worker) ←→ Model API
                             ←→ Tools (file, shell, API)
```

---

## Core Features

| Feature | Description |
| --- | --- |
| **Belief Extraction** | Rule-based parser extracts causal claims, assumptions, intentions, and evidence from each model response. No model dependency, sub-millisecond. |
| **Belief DAG** | Beliefs are linked into a directed acyclic graph across the session. When an action fails, backtrack to the root-cause belief. |
| **SSE Streaming Proxy** | Forwards model responses with zero added latency. Belief extraction runs in `waitUntil()` after the stream completes. |
| **Session State** | Durable Object per session holds the full belief graph in memory. No external database required. |
| **Timeline Dashboard** | Visual timeline of every decision point, beliefs behind it, confidence level, and evidence cited. Filter by type, confidence, or wrong beliefs only. |
| **Agent-Agnostic** | Works with Claude Code, Codex CLI, Cursor, Gemini CLI, Hermes, LangChain, and any agent that supports `base_url` override. |

---

## Advanced Capabilities

| Feature | Description |
| --- | --- |
| **Confidence Scoring** | Each extracted belief gets a confidence score (0.0–1.0) based on linguistic markers: "definitely" (0.9), "probably" (0.7), "might" (0.4), "not sure" (0.3). |
| **Belief Type Classification** | Four types: causal (why), assumption (what's taken as given), intention (what the agent will do), evidence (what was cited). Color-coded in dashboard. |
| **Root-Cause Backtracking** | When a failure occurs (error, wrong output, user correction), trace back through the belief DAG to the exact belief that caused the wrong action. |
| **Observability Integration** | Belief data exports as structured JSON — feed into Langfuse, Arize, Braintrust, or any OpenTelemetry-compatible tool as span metadata. |
| **Zero-Code Integration** | Change `base_url`. That's it. No SDK, no imports, no code changes. The agent runs normally while Axion observes in the background. |

---

## The Three Layers

| Layer | Name | Phase | What it does |
| :---: | --- | :---: | --- |
| 1 | **Axion Lens** | Shipping | Belief inspection — extracts the agent's reasoning chain, assumptions, and confidence from each response. Builds a belief DAG across the session. |
| 2 | **Axion Loop** | Planned | Revision loop breaker — embeds agent outputs, detects when an agent is stuck cycling the same reasoning, intervenes with targeted feedback instead of a crude kill signal. |
| 3 | **Axion Gate** | Planned | Runtime verification — intercepts tool calls before execution, checks plan alignment, contradiction, and failure patterns, then blocks or allows. |

> Lens is read-only and cannot break anything. It ships first and powers the other two: Loop uses the belief graph to classify loops, Gate uses the belief graph plus the stated plan to verify actions.

---

## Architecture

```
Phase 1 (Lens): Observe

  Agent
    ↕ HTTP
  Axion Proxy (CF Worker)
    ├── stream.ts        → SSE passthrough, zero added latency
    ├── extract.ts       → belief extraction (regex + NLP, <1ms)
    └── SessionDurableObject → belief DAG in memory
    ↕
  Model API

Phase 2 (Loop): Detect          Phase 3 (Gate): Block
  [planned]                       [planned]
```

---

## Quick Start

Requires Node.js and a Cloudflare account.

```bash
# Clone
git clone https://github.com/mosesman831/axion.git
cd axion

# Install
npm install

# Run locally
npm run dev
# → http://localhost:8787

# Point any agent at Axion
export ANTHROPIC_BASE_URL=http://localhost:8787
export OPENAI_BASE_URL=http://localhost:8787

# Open the dashboard
# → http://localhost:8787/dashboard
```

Deploy your own instance:

```bash
npx wrangler deploy
# → https://your-axion-worker.dev
```

---

## Integration

Axion works with any agent that supports `base_url` override. Zero code changes — set the environment variable and the agent runs normally.

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

Axion observes in the background. The agent behaves exactly as before — except every decision now has a visible, traceable belief behind it.

---

## Belief Extraction Patterns

| Type | Pattern Examples | Confidence |
| --- | --- | --- |
| **Causal** | "because X", "since X", "due to X", "as a result of X" | 0.6–0.9 |
| **Assumption** | "assuming X", "I'll assume X", "presumably X", "if X then Y" | 0.3–0.7 |
| **Intention** | "I'll do X", "I'm going to X", "let me X", "I should X" | 0.5–0.8 |
| **Evidence** | "based on X", "from the X", "according to X", "the error says X" | 0.6–0.9 |

Confidence modifiers: "definitely" (+0.2), "certainly" (+0.2), "probably" (+0.1), "might" (−0.2), "could be" (−0.1), "not sure" (−0.3).

---

## Roadmap

| Phase | Layer | Status | Ships |
| :---: | --- | :---: | --- |
| 1 | **Axion Lens** | In Progress | Proxy + belief extraction + local dashboard |
| 2 | **Axion Loop** | Planned | Embedding detection + intervention injection |
| 3 | **Axion Gate** | Planned | Tool-call interception + verification + blocking |

**Phase 1 open-source scope:** the proxy, the belief extraction engine, session state, and a local single-session dashboard. A hosted multi-session SaaS dashboard (cross-session analysis, team sharing, alerting, community pattern library) comes later.

---

## File Structure

```
axion/
├── src/
│   ├── proxy/                    CF Worker: stream proxy + interception
│   │   ├── index.ts              Worker entry point + routing
│   │   ├── stream.ts             SSE streaming + response teeing
│   │   ├── routes.ts             API route handlers (/dashboard, /api/beliefs)
│   │   ├── beliefs.ts            Belief storage coordination
│   │   ├── extraction.ts         Triggers belief extraction via waitUntil()
│   │   └── types.ts              Proxy-specific types
│   ├── lens/                     Belief extraction engine
│   │   ├── types.ts              ExtractedBelief, BeliefNode, BeliefDAG
│   │   ├── patterns.ts           Regex pattern definitions
│   │   ├── extract.ts            Main extraction function
│   │   └── index.ts              Re-exports
│   ├── state/                    Durable Object: session belief graph
│   │   └── SessionDurableObject.ts
│   └── dashboard/                React timeline UI
│       ├── index.html
│       ├── app.js
│       └── styles.css
├── SPEC.md                       Full architecture specification
├── TECHNICAL.md                  Technical deep-dive
├── wrangler.toml                 CF Worker config + DO bindings
├── tsconfig.json
└── package.json
```

---

## Tech Stack

- **Runtime** — Cloudflare Workers (edge proxy, zero cold start, global)
- **State** — Durable Objects (per-session belief graph, in memory)
- **Extraction** — Rule-based parser (regex + lightweight NLP), no model dependency, <1ms
- **Dashboard** — React (CDN, no build step), served from Worker static assets
- **External dependencies** — Zero in the open-source core

---

## Key Technical Details

- **Streaming:** Responses are streamed through via `ReadableStream` with a `TransformStream` tee — one stream goes to the caller, the other accumulates for belief extraction. Zero added latency on the hot path.
- **Extraction timing:** Belief extraction runs in `waitUntil()` after the response stream completes. The agent never waits for extraction.
- **Session isolation:** Each agent session gets its own Durable Object instance. Belief graphs are isolated per session, held in memory.
- **Pattern engine:** Regex patterns are defined as an extensible array in `patterns.ts`. New belief types or confidence modifiers can be added without touching the extraction logic.
- **Dashboard:** Uses React via CDN (no build step, no bundler). Served as static assets from the Worker. Dark theme, monospace, LatticeAG brand.

---

## Known Issues

- Phase 2 (Axion Loop) and Phase 3 (Axion Gate) are not yet implemented
- Dashboard uses CDN-hosted React — requires internet access for the dashboard page only (proxy works offline)
- Durable Object belief graph is in-memory — sessions are lost on DO eviction (acceptable for Phase 1)

---

## License

MIT — see [LICENSE](./LICENSE).

---

<div align="center">

**LatticeAG** — *Agents, together.*

[github.com/mosesman831](https://github.com/mosesman831)

</div>
