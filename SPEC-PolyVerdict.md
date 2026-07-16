# SPEC-PolyVerdict: Structured Output Firewall

> **Status:** Proposal — potential Axion Gate evolution
> **Type:** Feature spec (proxy layer for LLM output compliance)

## Problem

Apps calling LLMs get malformed JSON, hallucinated fields, type errors, and schema violations. Existing solutions (vLLM structured outputs, guidance, outlines) are inference-engine-integrated — you must use their runtime. There is no model-agnostic middleware.

## Relationship to Axion

| Axion Layer | PolyVerdict Relationship |
|-------------|-------------------------|
| Axion Lens | Lens extracts beliefs from model output. PolyVerdict ensures the output is structurally valid *before* belief extraction. |
| Axion Loop | Loop detects stuck agents. PolyVerdict prevents schema-violation loops by enforcing correct format. |
| Axion Gate | Gate blocks bad tool calls pre-execution. PolyVerdict blocks bad LLM responses pre-delivery. **Same pattern, different layer.** |

## Solution

A proxy layer that intercepts LLM responses and enforces:

1. **JSON Schema Compliance** — parse response against user-provided schema. Auto-retry with schema in prompt.
2. **Semantic Content Diff** — for critical fields, run a second model to verify content semantics.
3. **Type Coercion** — silently cast types (string "42" → int 42) instead of failing.
4. **Hallucination Detection** — use PolyGnosis-style adversarial verification on high-risk fields.

## Architecture

```
App → POST /v1/chat/completions (with x-schema header)
  → PolyVerdict Proxy (wraps same Worker pattern as Axion)
    → Schema Enforcement Layer
      → Retry Loop (max 3, with progressively stricter schema hints)
        → LLM (upstream API)
      ← Validated response
    → Semantic Verification (opt-in, per-field)
    → Type Coercion
  ← Clean typed JSON to app
```

## Key Design Decisions

- **Drop-in replacement** for OpenAI-compatible endpoints (change `base_url` only)
- **Schema format:** JSON Schema (draft 2020-12) via `response_format` extension
- **Same streaming architecture as Axion Lens** — `TransformStream` tee pattern, zero added latency on pass-through
- **Hash cache** — identical schema + identical prompt → skip verification
- **Cost control:** semantic verification is opt-in per field with a budget cap

## Integration With Axion

PolyVerdict runs in the same proxy as Axion:

```
Agent ↔ Axion Proxy
         ├── PolyVerdict (on response stream)
         │     └── Validates structure, enforces schema
         ├── Axion Lens (on completed response)
         │     └── Extracts beliefs from validated output
         ├── Axion Loop (on agent's next action)
         │     └── Detects loops using cleaner data
         └── Axion Gate (on tool calls)
               └── Blocks bad actions using verified beliefs
```

PolyVerdict feeds cleaner, more predictable data to Lens, which means Loop and Gate make better decisions.

## Implementation Notes

- Same `wrangler.toml` / `Durable Object` / `TransformStream` pattern as Axion Lens
- Schema registry: Durable Object that stores named schemas (avoids sending full JSON Schema on every request)
- `x-schema` header: `"schema-name"` or inline JSON Schema
- Retry: uses the failed schema violation as a hint in the retry prompt
- Models: use LexGateway for cost-optimised retry routing on the second attempt

## Success Criteria

- 100% schema compliance on valid model outputs
- <200ms overhead for syntax-only path (same budget as Axion Lens)
- <5% false positive rate on semantic verification
- Zero user-visible latency when schema passes on first try
