/**
 * Axion Lens - Session state Durable Object (Phase 1 timeline store).
 *
 * Phase 1 stores beliefs as an append-only chronological timeline, NOT a graph.
 * Each POST /store-beliefs call appends one batch (the beliefs extracted from a
 * single response) to the `"beliefs"` storage key. GET /beliefs flattens every
 * batch into one ordered list and returns the public shape
 * `{ sessionId, beliefs: ExtractedBelief[] }`.
 *
 * The `sessionId` returned is the human-readable session name (the value the
 * caller passed via `x-axion-session`, stored under `"sessionName"` on write),
 * never the opaque Durable Object id.
 *
 * The proxy talks to this DO via:
 *   env.SESSION.idFromName(sessionId) → stub → POST https://internal/store-beliefs
 *                                      → GET  https://internal/beliefs
 *
 * Wrangler binds this class as the `SESSION` Durable Object in wrangler.toml.
 *
 * @planned BeliefNode / BeliefDAG graph APIs (parent/child edges, root-cause
 *   routes) are intentionally not implemented here. See BUILD-SPEC decision D2.
 */

import type { ExtractionResult } from "../proxy/types";
import {
  flattenBeliefBatches,
  resolveSessionId,
  type BeliefBatch,
} from "./sessionBeliefs";

export class SessionDurableObject implements DurableObject {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // POST /store-beliefs - append one batch of beliefs for this session.
    if (url.pathname === "/store-beliefs" && request.method === "POST") {
      const result = (await request.json()) as ExtractionResult;
      const stored: BeliefBatch[] = (await this.state.storage.get("beliefs")) || [];
      stored.push({
        beliefs: result.beliefs,
        rawText: result.rawText,
        timestamp: result.timestamp,
      });
      await this.state.storage.put("beliefs", stored);
      // Persist the human-readable session name so GET can echo it back
      // instead of the opaque DO id. Refresh on every write.
      if (result.sessionId) {
        await this.state.storage.put("sessionName", result.sessionId);
      }
      return new Response(JSON.stringify({ ok: true, count: result.beliefs.length }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // GET /beliefs - return the flat chronological timeline for this session.
    if (url.pathname === "/beliefs" && request.method === "GET") {
      const stored: BeliefBatch[] = (await this.state.storage.get("beliefs")) || [];
      const sessionName = (await this.state.storage.get<string>("sessionName")) ?? null;
      // Fall back to a request hint (the id from the incoming path) when
      // nothing has been written yet. Never leak the opaque DO id.
      const hint = url.searchParams.get("sessionId");
      const beliefs = flattenBeliefBatches(stored);
      const sessionId = resolveSessionId(sessionName, hint);
      return new Response(JSON.stringify({ sessionId, beliefs }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  }
}
