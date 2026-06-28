# Axion

Agent cognitive middleware — a proxy layer that inspects, detects, and verifies agent reasoning. Open-source core. Hosted SaaS dashboard later.

By **LatticeAG** — *"Agents, together."*

## What It Does

Axion sits between an AI agent and the outside world. It intercepts model responses, agent outputs, and tool calls — then inspects, detects, and verifies agent reasoning in real time.

```
Agent ←→ Axion ←→ Model API
Agent ←→ Axion ←→ Tools (file, shell, API)
```

## Three Layers

| Layer | Name | Phase | What |
|---|---|---|---|
| 1 | **Axion Lens** | Shipping first | Belief inspection — extract and visualize the agent's reasoning chain |
| 2 | **Axion Loop** | Future | Revision loop breaker — detect stuck agents and intervene with targeted feedback |
| 3 | **Axion Gate** | Future | Runtime self-verification — block bad actions before they execute |

## Integration

Zero code changes. Set `base_url` to your Axion instance and the agent works normally.

```bash
# Claude Code
export ANTHROPIC_BASE_URL=https://your-axion-worker.dev

# Codex / OpenAI agents
export OPENAI_BASE_URL=https://your-axion-worker.dev
```

## Tech Stack

- Cloudflare Workers (edge proxy, zero cold start)
- Durable Objects (session state, belief graph)
- Rule-based extraction (no model dependency, <1ms)
- React dashboard (served from Worker static assets)

## Status

Phase 1 (Axion Lens) is in active development.

See [SPEC.md](./SPEC.md) for the full architecture and build plan.
