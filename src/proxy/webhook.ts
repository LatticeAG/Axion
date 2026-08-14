/**
 * Signed belief-batch webhook. Fired only after a successful Durable Object
 * store, and never on the observe response path.
 *
 * Unsigned delivery is refused unless AXION_WEBHOOK_ALLOW_UNSIGNED=true.
 * Missing secret with a URL set does not send.
 */

import type { ObservedAction } from "./actions";
import type { Belief, Env, ExtractionResult } from "./types";

export const WEBHOOK_SPEC = "axion.belief_batch.v1";
export const WEBHOOK_USER_AGENT = "axion-webhook/0.1.0";
export const WEBHOOK_ATTEMPT_TIMEOUT_MS = 2000;
export const WEBHOOK_MAX_RETRIES = 2;

export interface BeliefBatchWebhookPayload {
  spec: typeof WEBHOOK_SPEC;
  sessionId: string;
  timestamp: number;
  provider?: "openai" | "anthropic";
  modelName?: string;
  usage?: ExtractionResult["usage"];
  inboundMessageCount?: number;
  callsInSession: number;
  beliefs: Array<Omit<Belief, "rawText">>;
  actions: ObservedAction[];
  redactions: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Build the redacted webhook JSON. Never includes rawText. */
export function buildWebhookPayload(
  result: ExtractionResult,
  callsInSession: number,
): BeliefBatchWebhookPayload {
  const beliefs = result.beliefs.map((belief) => {
    const next: Omit<Belief, "rawText"> & { rawText?: string } = { ...belief };
    delete next.rawText;
    return next;
  });
  const payload: BeliefBatchWebhookPayload = {
    spec: WEBHOOK_SPEC,
    sessionId: result.sessionId,
    timestamp: result.timestamp,
    callsInSession,
    beliefs,
    actions: Array.isArray(result.actions) ? result.actions : [],
    redactions: typeof result.redactions === "number" ? result.redactions : 0,
  };
  if (result.provider === "openai" || result.provider === "anthropic") {
    payload.provider = result.provider;
  }
  if (typeof result.modelName === "string" && result.modelName.trim()) {
    payload.modelName = result.modelName.trim();
  }
  if (result.usage) payload.usage = result.usage;
  const inbound =
    result.inboundMessageCount ??
    (typeof result.messageCount === "number" ? result.messageCount : undefined);
  if (typeof inbound === "number") payload.inboundMessageCount = inbound;
  return payload;
}

export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * POST the batch to AXION_BELIEF_WEBHOOK_URL. Returns whether a request was
 * attempted. Failures are logged and counted on session meta.
 */
export async function sendWebhook(
  env: Env,
  result: ExtractionResult,
  callsInSession: number,
  opts?: { timeoutMs?: number },
): Promise<{ sent: boolean }> {
  const url = env.AXION_BELIEF_WEBHOOK_URL?.trim() ?? "";
  if (!url) return { sent: false };

  const secret = env.AXION_WEBHOOK_SECRET?.trim() ?? "";
  const allowUnsigned = env.AXION_WEBHOOK_ALLOW_UNSIGNED === "true";
  if (!secret && !allowUnsigned) {
    console.error("axion: webhook secret missing; delivery refused");
    return { sent: false };
  }

  const payload = buildWebhookPayload(result, callsInSession);
  const body = JSON.stringify(payload);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": WEBHOOK_USER_AGENT,
    "x-axion-session": result.sessionId,
  };
  if (secret) {
    headers["x-axion-signature"] = `sha256=${await hmacSha256Hex(secret, body)}`;
  }

  const attempts = WEBHOOK_MAX_RETRIES + 1;
  let lastError = "webhook did not run";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timeoutMs = opts?.timeoutMs ?? WEBHOOK_ATTEMPT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      if (response.ok) return { sent: true };
      lastError = `HTTP ${response.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }
  }

  console.error("axion: webhook delivery failed", lastError);
  await bumpWebhookFailures(env, result.sessionId);
  return { sent: false };
}

async function bumpWebhookFailures(env: Env, sessionId: string): Promise<void> {
  try {
    const id = env.SESSION.idFromName(sessionId);
    const stub = env.SESSION.get(id);
    await stub.fetch("https://internal/webhook-failure", { method: "POST" });
  } catch {
    // Counting is best-effort.
  }
}

export function parseStoreResponse(payload: unknown): {
  stored: boolean;
  callsInSession: number;
} {
  if (!isRecord(payload)) return { stored: false, callsInSession: 0 };
  const stored = payload.ok === true;
  const calls =
    typeof payload.callsInSession === "number" && Number.isFinite(payload.callsInSession)
      ? Math.max(0, Math.trunc(payload.callsInSession))
      : 0;
  return { stored, callsInSession: calls };
}
