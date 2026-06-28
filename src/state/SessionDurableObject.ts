/**
 * STUB - Axion Lens session Durable Object.
 *
 * This file is a placeholder so the proxy module typechecks before the real
 * Durable Object (src/state/SessionDurableObject.ts, built by another agent)
 * lands. The real implementation stores the per-session belief graph in DO
 * storage and serves it at the /beliefs route.
 *
 * The proxy talks to this DO via:
 *   env.SESSION.idFromName(sessionId) → stub → POST https://internal/store-beliefs
 *                                      → GET  https://internal/beliefs
 *
 * Wrangler binds this class as the `SESSION` Durable Object in wrangler.toml.
 */

import type { ExtractionResult } from "../proxy/types";

interface StoredBeliefs {
  beliefs: ExtractionResult["beliefs"];
  rawText: string;
  timestamp: number;
}

export class SessionDurableObject implements DurableObject {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // POST /store-beliefs - persist extracted beliefs for this session.
    if (url.pathname === "/store-beliefs" && request.method === "POST") {
      const result = (await request.json()) as ExtractionResult;
      const stored: StoredBeliefs[] = (await this.state.storage.get("beliefs")) || [];
      stored.push({
        beliefs: result.beliefs,
        rawText: result.rawText,
        timestamp: result.timestamp,
      });
      await this.state.storage.put("beliefs", stored);
      return new Response(JSON.stringify({ ok: true, count: result.beliefs.length }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // GET /beliefs - return the full belief graph for this session.
    if (url.pathname === "/beliefs" && request.method === "GET") {
      const stored: StoredBeliefs[] = (await this.state.storage.get("beliefs")) || [];
      return new Response(JSON.stringify({ sessionId: this.state.id.toString(), beliefs: stored }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  }
}
