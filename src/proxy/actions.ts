/**
 * Observed tool-call overlay. Visible OpenAI tool_calls and Anthropic tool_use
 * are stored on the belief batch. Raw arguments are not stored unless
 * AXION_STORE_TOOL_ARGS=true, and then only after secret redaction.
 *
 * Parsing failures still record the action with argumentFingerprintSource "raw".
 * This module must never throw into the observe path.
 */

import { redactSecrets } from "../redact/secrets";
import { SseLineParser } from "./stream";
import type { ProviderId } from "./providers/types";

export interface ObservedAction {
  id: string;
  name: string;
  provider: "openai" | "anthropic";
  source: "tool_calls" | "tool_use";
  argumentFingerprint: string;
  argumentFingerprintSource: "canonical" | "raw";
  argumentBytes: number;
  sourceClass: "tool_observed";
  argumentsRedacted?: string;
}

const MAX_TOOL_NAME_CHARS = 128;
export const MAX_ARGUMENTS_REDACTED_CHARS = 2048;

interface OpenAiToolBuffer {
  id: string;
  name: string;
  arguments: string;
}

interface AnthropicToolBuffer {
  id: string;
  name: string;
  json: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursively sort object keys so fingerprints are stable under key reorder. */
export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    out[key] = canonicalize(record[key]);
  }
  return out;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function clipName(name: string): string {
  return name.slice(0, MAX_TOOL_NAME_CHARS);
}

/**
 * Extract observed tool calls from a completed upstream body or accumulated SSE.
 */
export async function extractObservedActions(opts: {
  provider: ProviderId;
  isSse: boolean;
  raw: string;
  storeArgs?: boolean;
}): Promise<ObservedAction[]> {
  try {
    if (!opts.raw.trim()) return [];
    if (opts.provider === "anthropic") {
      return opts.isSse
        ? extractAnthropicSseActions(opts.raw, opts.storeArgs === true)
        : extractAnthropicJsonActions(opts.raw, opts.storeArgs === true);
    }
    return opts.isSse
      ? extractOpenAiSseActions(opts.raw, opts.storeArgs === true)
      : extractOpenAiJsonActions(opts.raw, opts.storeArgs === true);
  } catch {
    return [];
  }
}

async function extractOpenAiJsonActions(
  raw: string,
  storeArgs: boolean,
): Promise<ObservedAction[]> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(json) || !Array.isArray(json.choices)) return [];
  const first = json.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return [];
  const toolCalls = first.message.tool_calls;
  if (!Array.isArray(toolCalls)) return [];
  const actions: ObservedAction[] = [];
  for (const call of toolCalls) {
    if (!isRecord(call)) continue;
    const fn = isRecord(call.function) ? call.function : {};
    const name = typeof fn.name === "string" ? fn.name : "";
    const args = typeof fn.arguments === "string" ? fn.arguments : "";
    const id = typeof call.id === "string" && call.id.trim() ? call.id : crypto.randomUUID();
    actions.push(await buildAction({
      id,
      name,
      provider: "openai",
      source: "tool_calls",
      rawArgs: args,
      storeArgs,
    }));
  }
  return actions;
}

async function extractOpenAiSseActions(
  raw: string,
  storeArgs: boolean,
): Promise<ObservedAction[]> {
  const parser = new SseLineParser();
  const payloads = [...parser.feed(raw), ...parser.flush()];
  const buffers = new Map<number, OpenAiToolBuffer>();
  for (const payload of payloads) {
    if (payload.trim() === "[DONE]") continue;
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!isRecord(json) || !Array.isArray(json.choices)) continue;
    const first = json.choices[0];
    if (!isRecord(first) || !isRecord(first.delta)) continue;
    const toolCalls = first.delta.tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const fragment of toolCalls) {
      if (!isRecord(fragment)) continue;
      const index = typeof fragment.index === "number" ? fragment.index : 0;
      const existing = buffers.get(index) ?? { id: "", name: "", arguments: "" };
      if (typeof fragment.id === "string" && fragment.id) existing.id = fragment.id;
      const fn = isRecord(fragment.function) ? fragment.function : {};
      if (typeof fn.name === "string" && fn.name) existing.name = fn.name;
      if (typeof fn.arguments === "string") existing.arguments += fn.arguments;
      buffers.set(index, existing);
    }
  }
  const ordered = [...buffers.entries()].sort((a, b) => a[0] - b[0]);
  const actions: ObservedAction[] = [];
  for (const [, buf] of ordered) {
    if (!buf.name && !buf.arguments && !buf.id) continue;
    actions.push(await buildAction({
      id: buf.id || crypto.randomUUID(),
      name: buf.name,
      provider: "openai",
      source: "tool_calls",
      rawArgs: buf.arguments,
      storeArgs,
    }));
  }
  return actions;
}

async function extractAnthropicJsonActions(
  raw: string,
  storeArgs: boolean,
): Promise<ObservedAction[]> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(json) || !Array.isArray(json.content)) return [];
  const actions: ObservedAction[] = [];
  for (const block of json.content) {
    if (!isRecord(block) || block.type !== "tool_use") continue;
    const name = typeof block.name === "string" ? block.name : "";
    const id = typeof block.id === "string" && block.id.trim() ? block.id : crypto.randomUUID();
    const rawArgs = JSON.stringify(block.input ?? {});
    actions.push(await buildAction({
      id,
      name,
      provider: "anthropic",
      source: "tool_use",
      rawArgs,
      parsed: block.input,
      storeArgs,
    }));
  }
  return actions;
}

async function extractAnthropicSseActions(
  raw: string,
  storeArgs: boolean,
): Promise<ObservedAction[]> {
  const parser = new SseLineParser();
  const payloads = [...parser.feed(raw), ...parser.flush()];
  const buffers = new Map<number, AnthropicToolBuffer>();
  for (const payload of payloads) {
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!isRecord(json) || typeof json.type !== "string") continue;
    const index = typeof json.index === "number" ? json.index : 0;
    if (json.type === "content_block_start" && isRecord(json.content_block)) {
      const block = json.content_block;
      if (block.type !== "tool_use") continue;
      buffers.set(index, {
        id: typeof block.id === "string" ? block.id : "",
        name: typeof block.name === "string" ? block.name : "",
        json: "",
      });
    } else if (json.type === "content_block_delta" && isRecord(json.delta)) {
      if (json.delta.type !== "input_json_delta") continue;
      const existing = buffers.get(index);
      if (!existing) continue;
      if (typeof json.delta.partial_json === "string") {
        existing.json += json.delta.partial_json;
      }
    }
  }
  const ordered = [...buffers.entries()].sort((a, b) => a[0] - b[0]);
  const actions: ObservedAction[] = [];
  for (const [, buf] of ordered) {
    actions.push(await buildAction({
      id: buf.id || crypto.randomUUID(),
      name: buf.name,
      provider: "anthropic",
      source: "tool_use",
      rawArgs: buf.json,
      storeArgs,
    }));
  }
  return actions;
}

async function buildAction(opts: {
  id: string;
  name: string;
  provider: "openai" | "anthropic";
  source: "tool_calls" | "tool_use";
  rawArgs: string;
  parsed?: unknown;
  storeArgs: boolean;
}): Promise<ObservedAction> {
  let parsed = opts.parsed;
  let source: "canonical" | "raw" = "canonical";
  if (parsed === undefined) {
    try {
      parsed = opts.rawArgs.trim() ? JSON.parse(opts.rawArgs) : {};
    } catch {
      parsed = undefined;
      source = "raw";
    }
  }
  const hashed = source === "canonical" && parsed !== undefined
    ? canonicalJson(parsed)
    : opts.rawArgs;
  const fingerprint = await sha256Hex(hashed);
  const action: ObservedAction = {
    id: opts.id,
    name: clipName(opts.name),
    provider: opts.provider,
    source: opts.source,
    argumentFingerprint: fingerprint,
    argumentFingerprintSource: source === "canonical" ? "canonical" : "raw",
    argumentBytes: utf8Bytes(opts.rawArgs),
    sourceClass: "tool_observed",
  };
  if (opts.storeArgs) {
    const redacted = redactSecrets(opts.rawArgs);
    action.argumentsRedacted = redacted.text.slice(0, MAX_ARGUMENTS_REDACTED_CHARS);
  }
  return action;
}

/**
 * Stamp actionTaken with the tool name when a same-batch intention/planning
 * belief has an empty actionTaken. Exactly one empty candidate gets the name;
 * several attach to the last in source order.
 */
export function linkActionsToBeliefs<T extends { type: string; actionTaken?: string }>(
  beliefs: T[],
  actions: ObservedAction[],
): T[] {
  const next = beliefs.map((belief) => ({ ...belief }));
  for (const action of actions) {
    const candidates = next.filter(
      (belief) =>
        (belief.type === "intention" || belief.type === "planning") &&
        !String(belief.actionTaken ?? "").trim(),
    );
    if (candidates.length === 1) {
      candidates[0]!.actionTaken = action.name;
    } else if (candidates.length > 1) {
      candidates[candidates.length - 1]!.actionTaken = action.name;
    }
  }
  return next;
}
