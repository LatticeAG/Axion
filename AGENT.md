# Axion

Agent operator notes. Read [README.md](./README.md) for the product contract.

## Commands

Node 20+. From the repo root:

```bash
npm ci
npm run check    # tsc --noEmit && vitest run
npm run dev      # wrangler dev
```

Copy `.dev.vars.example` to `.dev.vars` for local secrets. Never commit `.dev.vars`.

## Invariants

- Observe path: tee the upstream body. Do not await extraction, redaction, webhook, registry, or search before returning the caller response.
- Fail open for the already authorized model response. Fail closed for telemetry.
- Never send `Bearer undefined`. Never log Authorization, x-api-key, AXION_READ_TOKEN, AXION_WEBHOOK_SECRET, or unredacted rawText.
- Axion observes visible artifacts only. Do not recover hidden chain of thought.
- PolyVerdict enforce is opt-in. No schema means no enforce.
- This Worker is private (`package.json` `"private": true`). Do not invent an npm `axion/lens` export.

## Scope this cycle

Production gaps plus two features: native tool-call capture and a signed belief-batch webhook. No Loop, Gate, DAG routes, Gemini, OTLP client, MCP, or SaaS control plane.
