/**
 * PolyVerdict v1 - enforce path: schema-trigger detection, single-shot
 * enforcement, and retry-hint injection.
 *
 * Everything here is intentionally pure (no `fetch`, no globals) so the proxy
 * integrator can drive the retry loop around its own upstream call. See
 * {@link runEnforceLoop} for a ready-made driver that takes an injected
 * upstream callback, and the "Integrator loop" note below for the manual
 * shape.
 *
 * Integrator loop (manual):
 *   1. const trigger = detectSchemaTrigger(request.headers, body);
 *      if (!trigger) → fall through to the normal observe/tee path.
 *   2. Force `stream: false` upstream (enforce always buffers).
 *   3. for attempt in 1..MAX_ENFORCE_ATTEMPTS:
 *        text   = <assistant text from upstream response>
 *        result = enforceOnce(text, trigger.schema)
 *        if (result.ok) → return provider-shaped JSON (result.jsonText)
 *        else if (attempt < MAX) → messages = buildRetryMessages(
 *              messages, { schema: trigger.schema, errors: result.errors,
 *                          assistantText: text })  // Anthropic variant for /v1/messages
 *        else → return last text + surface result.errors
 */

import {
  parseJsonFromAssistant,
  validateAndCoerce,
} from './schema.js';
import type {
  AnthropicMessage,
  OpenAiMessage,
  SchemaTrigger,
} from './types.js';
export type { SchemaTrigger } from './types.js';

/** Maximum total upstream attempts (initial call + retries) in enforce mode. */
export const MAX_ENFORCE_ATTEMPTS = 3;

/** Result of a single enforcement attempt on one assistant message. */
export interface EnforceResult {
  /** True when the text parsed and validated (after coercion). */
  ok: boolean;
  /** The coerced value (present only when `ok`). */
  value?: unknown;
  /** Canonical serialization of `value` to hand back to the caller. */
  jsonText?: string;
  /** Violation messages (empty when `ok`). */
  errors: string[];
}

/**
 * Inspect an incoming request for a PolyVerdict schema trigger.
 *
 * Two triggers are recognised (header takes precedence):
 *   - `x-axion-schema`: inline JSON Schema. Parsed directly; if that fails we
 *     retry after `decodeURIComponent` (headers are often URL-encoded).
 *   - body `response_format: { type: "json_schema", json_schema: { schema } }`
 *     (OpenAI structured-output style).
 *
 * Returns `null` when no valid trigger is present, so the caller can skip the
 * enforce path entirely.
 */
export function detectSchemaTrigger(
  requestHeaders: Headers,
  body: unknown,
): SchemaTrigger | null {
  const headerTrigger = triggerFromHeader(requestHeaders);
  if (headerTrigger) return headerTrigger;
  return triggerFromBody(body);
}

function triggerFromHeader(headers: Headers): SchemaTrigger | null {
  const raw = headers.get('x-axion-schema');
  if (!raw || raw.trim() === '') return null;

  const schema = parseSchemaHeader(raw);
  if (schema === undefined) return null;
  return { schema };
}

/** Parse a header value as JSON, falling back to a URL-decoded parse. */
function parseSchemaHeader(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw);
  } catch {
    // fall through to decode attempt
  }
  try {
    return JSON.parse(decodeURIComponent(raw));
  } catch {
    return undefined;
  }
}

function triggerFromBody(body: unknown): SchemaTrigger | null {
  if (!isObject(body)) return null;
  const rf = (body as Record<string, unknown>).response_format;
  if (!isObject(rf)) return null;
  if (rf.type !== 'json_schema') return null;

  const js = rf.json_schema;
  if (!isObject(js)) return null;
  if (!('schema' in js)) return null;

  const name = typeof js.name === 'string' ? js.name : undefined;
  return { schema: js.schema, name };
}

/**
 * Run one enforcement pass over an assistant text: strip fences, parse JSON,
 * then validate + coerce against `schema`.
 */
export function enforceOnce(
  assistantText: string,
  schema: unknown,
): EnforceResult {
  const parsed = parseJsonFromAssistant(assistantText);
  if (!parsed.ok) {
    return { ok: false, errors: [`JSON parse failed: ${parsed.error}`] };
  }

  const validated = validateAndCoerce(parsed.value, schema);
  if (!validated.ok) {
    return { ok: false, errors: validated.errors };
  }

  return {
    ok: true,
    value: validated.value,
    jsonText: JSON.stringify(validated.value),
    errors: [],
  };
}

// ── Retry-hint injection ────────────────────────────────────────────────────

/** Context used to build a corrective retry message. */
export interface RetryContext {
  /** The JSON Schema the output must satisfy. */
  schema: unknown;
  /** Violations from the previous attempt. */
  errors: string[];
  /** The assistant text that failed (echoed back so the model can self-correct). */
  assistantText?: string;
  /** Optional schema name for the instruction. */
  name?: string;
}

/**
 * Build the corrective instruction text appended on a retry. Shared by both
 * provider variants.
 */
export function buildViolationHint(ctx: RetryContext): string {
  const label = ctx.name ? ` "${ctx.name}"` : '';
  const schemaJson = safeStringify(ctx.schema);
  const violations = ctx.errors.length
    ? ctx.errors.map((e) => `- ${e}`).join('\n')
    : '- output was not valid JSON';

  return [
    `Your previous response did not satisfy the required JSON schema${label}.`,
    '',
    'Schema violations:',
    violations,
    '',
    'Required JSON schema:',
    schemaJson,
    '',
    'Respond again with ONLY a single JSON value that satisfies the schema.',
    'Do not include any prose, explanation, or Markdown code fences.',
  ].join('\n');
}

/**
 * Append retry turns to an OpenAI-style `messages` array: the failed assistant
 * output (when available) followed by a user correction message. Returns a new
 * array; the input is not mutated.
 */
export function buildRetryMessages(
  messages: OpenAiMessage[],
  ctx: RetryContext,
): OpenAiMessage[] {
  const next: OpenAiMessage[] = [...messages];
  if (typeof ctx.assistantText === 'string' && ctx.assistantText.trim() !== '') {
    next.push({ role: 'assistant', content: ctx.assistantText });
  }
  next.push({ role: 'user', content: buildViolationHint(ctx) });
  return next;
}

/**
 * Anthropic Messages variant of {@link buildRetryMessages}. Text content is
 * emitted as plain strings, which the Messages API accepts.
 */
export function buildRetryMessagesAnthropic(
  messages: AnthropicMessage[],
  ctx: RetryContext,
): AnthropicMessage[] {
  const next: AnthropicMessage[] = [...messages];
  if (typeof ctx.assistantText === 'string' && ctx.assistantText.trim() !== '') {
    next.push({ role: 'assistant', content: ctx.assistantText });
  }
  next.push({ role: 'user', content: buildViolationHint(ctx) });
  return next;
}

// ── Optional driver ─────────────────────────────────────────────────────────

/** Outcome of {@link runEnforceLoop}. */
export interface EnforceLoopResult extends EnforceResult {
  /** Number of upstream attempts actually made (1..MAX_ENFORCE_ATTEMPTS). */
  attempts: number;
  /** The final assistant text seen (last attempt). */
  finalText: string;
}

/**
 * Drive the enforce retry loop with an injected upstream callback. Keeps
 * PolyVerdict free of any transport concerns: the integrator supplies a
 * function that sends the current `messages` upstream (non-streaming) and
 * resolves to the assistant text.
 *
 * @param messages   Initial OpenAI-style messages.
 * @param schema     The JSON Schema to enforce.
 * @param callUpstream  Sends messages upstream, returns assistant text.
 * @param opts       Optional schema name / max attempts / message builder.
 */
export async function runEnforceLoop(
  messages: OpenAiMessage[],
  schema: unknown,
  callUpstream: (messages: OpenAiMessage[], attempt: number) => Promise<string>,
  opts: {
    name?: string;
    maxAttempts?: number;
    buildRetry?: (messages: OpenAiMessage[], ctx: RetryContext) => OpenAiMessage[];
  } = {},
): Promise<EnforceLoopResult> {
  const maxAttempts = clampAttempts(opts.maxAttempts ?? MAX_ENFORCE_ATTEMPTS);
  const buildRetry = opts.buildRetry ?? buildRetryMessages;

  let current = messages;
  let lastText = '';
  let last: EnforceResult = { ok: false, errors: ['no upstream attempt made'] };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastText = await callUpstream(current, attempt);
    last = enforceOnce(lastText, schema);
    if (last.ok) {
      return { ...last, attempts: attempt, finalText: lastText };
    }
    if (attempt < maxAttempts) {
      current = buildRetry(current, {
        schema,
        errors: last.errors,
        assistantText: lastText,
        name: opts.name,
      });
    }
  }

  return { ...last, attempts: maxAttempts, finalText: lastText };
}

// ── utilities ────────────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clampAttempts(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), MAX_ENFORCE_ATTEMPTS);
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
