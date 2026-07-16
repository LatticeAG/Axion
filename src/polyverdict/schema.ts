/**
 * PolyVerdict v1 - minimal JSON Schema subset validator + type coercion.
 *
 * Zero npm dependencies. Implements just enough of JSON Schema to enforce
 * structured LLM output:
 *
 *   - `type`: object | array | string | number | integer | boolean | null
 *   - `properties` (nested), `required`, `items` (schema or tuple), `enum`
 *   - unknown keywords are ignored (never an error)
 *
 * Coercion (BUILD-SPEC §7): string "42" → number/integer, "true"/"false" →
 * boolean, number/boolean → string when the schema says string. Coercion is
 * best-effort: a value is only rewritten when the target type is unambiguous.
 *
 * Public API:
 *   validateAndCoerce(data, schema): { ok, value } | { ok:false, errors }
 *   stripMarkdownFences(text): string
 *   parseJsonFromAssistant(text): { ok, value } | { ok:false, error }
 */

import type {
  JsonSchema,
  JsonSchemaType,
  ParseResult,
  ValidationResult,
} from './types.js';

const KNOWN_TYPES: readonly JsonSchemaType[] = [
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
];

/**
 * Validate `data` against `schema`, coercing primitive types where the schema
 * makes the intent unambiguous. Returns the (possibly rewritten) value on
 * success, or a flat list of violation messages on failure.
 */
export function validateAndCoerce(
  data: unknown,
  schema: unknown,
): ValidationResult {
  const errors: string[] = [];
  const value = coerceNode(data, schema, '$', errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value };
}

/**
 * Recursively validate + coerce a single node. Pushes any violations onto
 * `errors` (keyed by JSON path) and returns the best-effort coerced value.
 */
function coerceNode(
  data: unknown,
  schema: unknown,
  path: string,
  errors: string[],
): unknown {
  // A non-object schema (or `true`) imposes no constraints.
  if (!isPlainObject(schema)) return data;
  const s = schema as JsonSchema;

  let value = data;

  // 1. Type coercion / checking.
  const type = s.type;
  if (typeof type === 'string' && (KNOWN_TYPES as string[]).includes(type)) {
    value = coerceType(value, type as JsonSchemaType, path, errors);
  } else if (Array.isArray(type)) {
    value = coerceUnionType(value, type, path, errors);
  }

  // 2. Structural recursion (independent of an explicit `type`, so a bare
  //    `{ properties: ... }` schema still validates nested objects).
  if (isPlainObject(value) && isPlainObject(s.properties)) {
    value = coerceObject(value, s, path, errors);
  } else if (Array.isArray(value) && s.items !== undefined) {
    value = coerceArray(value, s.items, path, errors);
  } else if (isPlainObject(value) && Array.isArray(s.required)) {
    // `required` without `properties`: still enforce presence.
    checkRequired(value, s.required, path, errors);
  }

  // 3. Enum membership (checked after coercion so "42" → 42 can still match).
  if (Array.isArray(s.enum)) {
    if (!s.enum.some((candidate) => deepEqual(candidate, value))) {
      errors.push(
        `${path}: value ${short(value)} is not one of ${short(s.enum)}`,
      );
    }
  }

  return value;
}

/** Coerce/validate a value against a single primitive type. */
function coerceType(
  value: unknown,
  type: JsonSchemaType,
  path: string,
  errors: string[],
): unknown {
  switch (type) {
    case 'string':
      if (typeof value === 'string') return value;
      // number → string, boolean → string.
      if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
      }
      if (typeof value === 'boolean') return String(value);
      errors.push(`${path}: expected string, got ${typeName(value)}`);
      return value;

    case 'number':
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string' && isNumericString(value)) {
        return Number(value);
      }
      errors.push(`${path}: expected number, got ${typeName(value)}`);
      return value;

    case 'integer':
      if (typeof value === 'number' && Number.isInteger(value)) return value;
      if (typeof value === 'string' && isIntegerString(value)) {
        return Number(value);
      }
      errors.push(`${path}: expected integer, got ${typeName(value)}`);
      return value;

    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      errors.push(`${path}: expected boolean, got ${typeName(value)}`);
      return value;

    case 'null':
      if (value === null) return null;
      errors.push(`${path}: expected null, got ${typeName(value)}`);
      return value;

    case 'object':
      if (isPlainObject(value)) return value;
      errors.push(`${path}: expected object, got ${typeName(value)}`);
      return value;

    case 'array':
      if (Array.isArray(value)) return value;
      errors.push(`${path}: expected array, got ${typeName(value)}`);
      return value;

    default:
      return value;
  }
}

/**
 * Coerce against a union `type: [...]`. If the value already matches one of
 * the listed types it is kept; otherwise we attempt coercion to the first
 * type and only report the failure if none succeed.
 */
function coerceUnionType(
  value: unknown,
  types: JsonSchemaType[],
  path: string,
  errors: string[],
): unknown {
  const known = types.filter((t) => (KNOWN_TYPES as string[]).includes(t));
  if (known.length === 0) return value;

  if (known.some((t) => matchesType(value, t))) return value;

  for (const t of known) {
    const local: string[] = [];
    const coerced = coerceType(value, t, path, local);
    if (local.length === 0) return coerced;
  }

  errors.push(`${path}: expected one of [${known.join(', ')}], got ${typeName(value)}`);
  return value;
}

/** Validate an object's `properties` + `required`, returning a coerced copy. */
function coerceObject(
  value: Record<string, unknown>,
  schema: JsonSchema,
  path: string,
  errors: string[],
): Record<string, unknown> {
  const props = schema.properties as Record<string, unknown>;
  const out: Record<string, unknown> = { ...value };

  if (Array.isArray(schema.required)) {
    checkRequired(value, schema.required, path, errors);
  }

  for (const key of Object.keys(props)) {
    if (!(key in value)) continue; // presence handled by `required`
    const childPath = `${path}.${key}`;
    out[key] = coerceNode(value[key], props[key], childPath, errors);
  }

  return out;
}

/** Validate array `items` (single schema or positional tuple). */
function coerceArray(
  value: unknown[],
  items: unknown,
  path: string,
  errors: string[],
): unknown[] {
  if (Array.isArray(items)) {
    // Tuple validation: schema per position.
    return value.map((el, i) =>
      i < items.length ? coerceNode(el, items[i], `${path}[${i}]`, errors) : el,
    );
  }
  // Single schema applied to every element.
  return value.map((el, i) => coerceNode(el, items, `${path}[${i}]`, errors));
}

/** Push an error for each missing required property. */
function checkRequired(
  value: Record<string, unknown>,
  required: string[],
  path: string,
  errors: string[],
): void {
  for (const name of required) {
    if (typeof name !== 'string') continue;
    if (!(name in value)) {
      errors.push(`${path}: missing required property "${name}"`);
    }
  }
}

// ── JSON extraction helpers ─────────────────────────────────────────────────

/**
 * Remove Markdown code-fence wrappers from an assistant message.
 *
 * Handles ```` ```json … ``` ````, ```` ``` … ``` ````, and fenced blocks
 * embedded in surrounding prose. If no fence is present the trimmed input is
 * returned unchanged.
 */
export function stripMarkdownFences(text: string): string {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();

  // A fenced block anywhere in the text: ```lang\n … \n```
  const fenced = trimmed.match(/```[ \t]*([A-Za-z0-9_-]+)?[ \t]*\r?\n?([\s\S]*?)```/);
  if (fenced) return fenced[2]!.trim();

  return trimmed;
}

/**
 * Parse JSON from an assistant response, tolerating Markdown fences and
 * surrounding prose. Falls back to extracting the first balanced-looking
 * `{...}` / `[...]` span before giving up.
 */
export function parseJsonFromAssistant(text: string): ParseResult {
  const stripped = stripMarkdownFences(text);

  const direct = tryParse(stripped);
  if (direct.ok) return direct;

  const candidate = extractFirstJsonSpan(stripped);
  if (candidate !== null) {
    const fromSpan = tryParse(candidate);
    if (fromSpan.ok) return fromSpan;
  }

  return {
    ok: false,
    error: direct.ok ? 'unreachable' : direct.error,
  };
}

function tryParse(text: string): ParseResult {
  const t = text.trim();
  if (t === '') return { ok: false, error: 'empty response' };
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Extract the first plausibly-complete JSON object/array from `text` by
 * matching the outermost brackets. Best-effort only; the real parse still runs
 * afterward. Skips brackets inside string literals.
 */
function extractFirstJsonSpan(text: string): string | null {
  const start = firstBracketIndex(text);
  if (start === -1) return null;

  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function firstBracketIndex(text: string): number {
  const obj = text.indexOf('{');
  const arr = text.indexOf('[');
  if (obj === -1) return arr;
  if (arr === -1) return obj;
  return Math.min(obj, arr);
}

// ── small utilities ─────────────────────────────────────────────────────────

/** True for a plain (non-array, non-null) object. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Does `value` already satisfy the given primitive type (no coercion)? */
function matchesType(value: unknown, type: JsonSchemaType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    default:
      return false;
  }
}

/** A string that Number() maps to a finite value (rejecting "" / whitespace). */
function isNumericString(s: string): boolean {
  if (s.trim() === '') return false;
  return Number.isFinite(Number(s));
}

/** A numeric string whose value is an integer. */
function isIntegerString(s: string): boolean {
  return isNumericString(s) && Number.isInteger(Number(s));
}

/** Human-readable type name for error messages. */
function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** Structural equality via JSON serialization; good enough for enum checks. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** Compact, length-capped JSON preview for error messages. */
function short(v: unknown): string {
  let str: string;
  try {
    str = JSON.stringify(v);
  } catch {
    str = String(v);
  }
  if (str === undefined) str = String(v);
  return str.length > 80 ? `${str.slice(0, 77)}...` : str;
}
