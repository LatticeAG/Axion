/**
 * PolyVerdict v1 - shared type definitions.
 *
 * PolyVerdict is Axion's opt-in *enforce* path: when a caller supplies a JSON
 * Schema (via the `x-axion-schema` header or an OpenAI-style
 * `response_format.json_schema`), the proxy validates and type-coerces the
 * model's output against that schema, retrying with violation hints up to
 * {@link MAX_ENFORCE_ATTEMPTS} times.
 *
 * Scope (BUILD-SPEC §7 / D8): syntax validate + type coerce + retry ≤ 3.
 * No semantic verification, no second-model check, no schema-registry DO.
 */

/**
 * A detected PolyVerdict enforce trigger: the JSON Schema the output must
 * satisfy, plus an optional caller-supplied name (from `response_format`).
 */
export interface SchemaTrigger {
  schema: unknown;
  name?: string;
}

/** Successful result carrying a (possibly coerced) value. */
export interface Ok<T> {
  ok: true;
  value: T;
}

/** Failure result carrying a list of human-readable violation messages. */
export interface Err {
  ok: false;
  errors: string[];
}

/** Result of {@link validateAndCoerce}: coerced value or a list of errors. */
export type ValidationResult = Ok<unknown> | Err;

/** Result of {@link parseJsonFromAssistant}: parsed value or a single error. */
export type ParseResult = Ok<unknown> | { ok: false; error: string };

/**
 * The JSON-primitive type names understood by the minimal schema subset.
 * Anything else in a schema's `type` is treated as "no type constraint".
 */
export type JsonSchemaType =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'null';

/**
 * The subset of JSON Schema keywords PolyVerdict v1 understands. All other
 * keywords are ignored (not an error). `schema` inputs are typed as `unknown`
 * at the public boundary; this interface documents the recognised shape.
 */
export interface JsonSchema {
  type?: JsonSchemaType | JsonSchemaType[];
  properties?: Record<string, unknown>;
  required?: string[];
  items?: unknown | unknown[];
  enum?: unknown[];
  [keyword: string]: unknown;
}

/** A single chat message in the OpenAI chat-completions format. */
export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | string;
  content: string;
}

/** A text block in the Anthropic Messages format. */
export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

/** A single message in the Anthropic Messages format. */
export interface AnthropicMessage {
  role: 'user' | 'assistant' | string;
  content: string | AnthropicTextBlock[];
}
