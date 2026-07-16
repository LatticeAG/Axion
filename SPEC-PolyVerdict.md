# PolyVerdict: structured output enforcement

> **Status:** partially implemented. The syntax path ships (opt-in). Semantic verification is future work.
> **Type:** feature spec for an opt-in enforce path in the Axion Worker.
> **Scope lock:** [BUILD-SPEC.md](./BUILD-SPEC.md) D7/D8. This spec must not describe the enforce path as default Lens middleware; it runs only when a caller supplies a schema.
> **Full normative specification: [SPEC.md](./SPEC.md) §16** covers the complete enforce contract (trigger detection, retry loop, schema subset, coercion matrix, response shapes). This file is the focused companion; where the two differ, SPEC.md wins.

## What ships today

PolyVerdict v1 is an opt-in enforce path in the same Worker as Axion Lens. It runs only when a request carries a JSON Schema. Code lives in `src/polyverdict/` and is wired into `src/proxy/index.ts`.

Implemented:

1. **Schema trigger detection.** `x-axion-schema` header (JSON, URL-decoded as a fallback), or body `response_format: { type: "json_schema", json_schema: { schema, name? } }`. Header wins. No trigger means the request stays on the observe path.
2. **Non-streaming enforce.** The upstream call is forced to `stream: false` so the full payload can be validated. The client `response_format` is stripped upstream; the Worker owns validation.
3. **Parse.** Strip Markdown fences, then `JSON.parse`, with a balanced-bracket fallback for JSON embedded in prose.
4. **Validate against a minimal JSON Schema subset.** `type` (single or union), `properties`, `required`, `items` (schema or tuple), `enum`, and nesting. Unknown keywords are ignored.
5. **Type coercion.** `"42"` to number/integer, `"true"`/`"false"` to boolean, finite number/boolean to string. Coercion runs before enum checks.
6. **Retry with hints.** On a violation the errors are appended as a correction message and the model is called again, up to 3 attempts total. OpenAI and Anthropic message shapes are both handled.
7. **Result.** On success, a provider-shaped 200 whose assistant content is the coerced JSON string; Lens then extracts from that delivered text. After 3 failed attempts, HTTP 422 with the violation list.

## What is not built

These appeared in the original proposal and are not implemented:

- **Semantic content diff / second-model verification.** No field is checked by a second model.
- **Hallucination detection (PolyGnosis-style).** Not present.
- **Schema registry Durable Object.** Named schemas are not supported. Schemas are inline (header JSON or `response_format`) only.
- **Hash cache** for identical schema plus prompt. Not present; every enforce request calls upstream.
- **LexGateway cost-optimised retry routing.** Retries hit the same upstream as the first attempt.
- **Streaming enforce.** Enforce always returns non-streaming JSON, even if the client asked to stream.

## Problem

Apps calling LLMs get malformed JSON, missing fields, and type errors. Inference-side tools (structured decoding in vLLM, guidance, outlines) require you to run their engine. PolyVerdict is model-agnostic middleware: change the base URL, add a schema, get validated JSON back or a 422.

## Relationship to Axion

| Axion layer | Relationship |
|---|---|
| Lens | Lens observes; PolyVerdict enforces. Enforce runs Lens on the delivered (coerced) text, so beliefs come from validated output. |
| Loop | Planned. A format-enforced output removes one class of retry loop, but Loop itself is not built. |
| Gate | Planned. PolyVerdict is Gate-shaped (validate, retry, block) but scoped to response format, not tool calls. |

## Architecture (as built)

```
App -> POST /v1/chat/completions or /v1/messages
       with x-axion-schema  OR  response_format.json_schema
  |
  v
detectSchemaTrigger -> present?
  |- no  -> observe path (tee + Lens), unchanged
  |- yes -> enforce loop (<=3):
             force stream:false -> upstream
             extract assistant text
             strip fences -> parse JSON
             validateAndCoerce(schema)
               ok    -> provider-shaped 200 (coerced JSON) + Lens on delivered text
               fail  -> append violation hint, retry
             exhausted -> 422 with violations
```

## Design decisions

- **Opt-in, separate path.** Enforce is never applied to a request without a schema. The default observe path stays zero added latency.
- **Buffered by design.** Validating a partial stream is not meaningful, so enforce forces a full non-streaming payload. The zero-latency guarantee does not apply here.
- **Drop-in.** Same base-URL override as the observe path; the schema is the only extra input.
- **Zero dependencies.** The validator is hand-written; no schema library is pulled in.

## Future work

- Semantic verification, opt-in and budget-capped per field.
- Schema registry Durable Object for named schemas, keyed separately from session state.
- Hash cache to skip upstream when an identical schema plus prompt already passed.
- Wider JSON Schema coverage (formats, patterns, numeric bounds).

These are deferred until the syntax path and the Lens contracts have proven out. See [PLAN.md](./PLAN.md) for sequencing.
