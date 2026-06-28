/**
 * Axion Lens — Belief extraction trigger.
 *
 * Glue between the proxy and the lens module. We import extractBeliefs from the
 * lens (built by another agent) and forward the result to the Durable Object
 * for storage. All wrapped in ctx.waitUntil() by the caller so it runs after
 * the response is returned, with zero added latency to the caller.
 */

import { extractBeliefs } from "../lens/extract";
import type { Env, ExtractionResult } from "./types";

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
  responseText: string
): Promise<void> {
  if (!responseText || !responseText.trim()) return;

  let result: ExtractionResult;
  try {
    const beliefs = await extractBeliefs(responseText);
    result = {
      sessionId,
      beliefs,
      rawText: responseText,
      timestamp: Date.now(),
    };
  } catch (err) {
    // Extraction must never break the proxy. Log and bail.
    console.error(
      "axion: belief extraction failed",
      err instanceof Error ? err.message : String(err)
    );
    return;
  }

  // Persist to the Durable Object for this session.
  try {
    const stub = env.SESSION.idFromName(sessionId);
    const doResponse = await stub.fetch(
      `https://internal/store-beliefs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result),
      }
    );
    if (!doResponse.ok) {
      console.error(
        "axion: failed to store beliefs in DO",
        doResponse.status,
        await doResponse.text().catch(() => "<no body>")
      );
    }
  } catch (err) {
    console.error(
      "axion: DO store threw",
      err instanceof Error ? err.message : String(err)
    );
  }
}
