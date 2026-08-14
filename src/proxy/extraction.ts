/**
 * Axion Lens - Belief extraction trigger.
 *
 * Glue between the proxy and the lens module. We import extractBeliefs from the
 * lens (built by another agent) and forward the result to the Durable Object
 * for storage. All wrapped in ctx.waitUntil() by the caller so it runs after
 * the response is returned, with zero added latency to the caller.
 */

import { extractBeliefs } from "../lens/extract";
import { redactSecrets } from "../redact/secrets";
import { linkActionsToBeliefs, type ObservedAction } from "./actions";
import type { Belief, Env, ExtractionResult } from "./types";
import type { TokenUsage } from "./usage";
import { parseStoreResponse, sendWebhook } from "./webhook";

/** Metadata captured for the model call that produced a belief batch. */
export interface ExtractionCallMetadata {
  usage?: TokenUsage;
  modelName?: string;
  provider?: "openai" | "anthropic";
  messageCount?: number;
  inboundMessageCount?: number;
  waitUntil?: (p: Promise<unknown>) => void;
  actions?: ObservedAction[];
}

/**
 * Run belief extraction on a completed response and persist results to the
 * session's Durable Object. Designed to be called via ctx.waitUntil().
 *
 * @param env        Worker bindings
 * @param sessionId  Session ID (x-axion-session header or generated UUID)
 * @param responseText  Full accumulated response text (deltas joined for SSE)
 */
export async function runExtraction(
  env: Env,
  sessionId: string,
  responseText: string,
  metadata: ExtractionCallMetadata = {},
): Promise<{ stored: boolean }> {
  let result: ExtractionResult;
  try {
    const beliefs = await extractBeliefs(responseText || "", { sessionId });
    const actions = Array.isArray(metadata.actions) ? metadata.actions : [];
    const linked = linkActionsToBeliefs(beliefs, actions);
    const redacted = redactExtraction(responseText || "", linked);
    const { waitUntil, ...persistMeta } = metadata;
    void waitUntil;
    result = {
      sessionId,
      beliefs: redacted.beliefs,
      rawText: redacted.rawText,
      timestamp: Date.now(),
      redactions: redacted.redactions,
      ...persistMeta,
      actions,
    };
  } catch (err) {
    console.error(
      "axion: belief extraction failed",
      err instanceof Error ? err.message : String(err)
    );
    return { stored: false };
  }

  try {
    const id = env.SESSION.idFromName(sessionId);
    const stub = env.SESSION.get(id);
    const doResponse = await stub.fetch(`https://internal/store-beliefs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result),
    });
    if (!doResponse.ok) {
      console.error(
        "axion: failed to store beliefs in DO",
        doResponse.status,
        await doResponse.text().catch(() => "<no body>")
      );
      return { stored: false };
    }
    let callsInSession = 0;
    try {
      const parsed = parseStoreResponse(await doResponse.json());
      callsInSession = parsed.callsInSession;
    } catch {
      callsInSession = 0;
    }
    if (env.AXION_BELIEF_WEBHOOK_URL?.trim() && metadata.waitUntil) {
      metadata.waitUntil(sendWebhook(env, result, callsInSession));
    }
    return { stored: true };
  } catch (err) {
    console.error(
      "axion: DO store threw",
      err instanceof Error ? err.message : String(err)
    );
    return { stored: false };
  }
}

/** Redact secrets on persist fields. Never log the matched secret. */
function redactExtraction(
  rawText: string,
  beliefs: Belief[],
): { rawText: string; beliefs: Belief[]; redactions: number } {
  const redactedRaw = redactSecrets(rawText);
  let redactions = redactedRaw.hits;
  const nextBeliefs = beliefs.map((belief) => {
    const beliefText = redactSecrets(belief.belief);
    redactions += beliefText.hits;
    const surrounding = redactSecrets(belief.rawText);
    redactions += surrounding.hits;
    const next: Belief = {
      ...belief,
      belief: beliefText.text,
      rawText: surrounding.text,
    };
    if (belief.evidence) {
      const evidence = redactSecrets(belief.evidence);
      redactions += evidence.hits;
      next.evidence = evidence.text;
    }
    if (belief.actionTaken) {
      const actionTaken = redactSecrets(belief.actionTaken);
      redactions += actionTaken.hits;
      next.actionTaken = actionTaken.text;
    }
    return next;
  });
  return { rawText: redactedRaw.text, beliefs: nextBeliefs, redactions };
}
