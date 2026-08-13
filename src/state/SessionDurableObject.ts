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

import type { Env, ExtractionResult } from "../proxy/types";
import {
  aggregateBatchUsage,
  flattenBeliefBatches,
  resolveSessionId,
  type BeliefBatch,
} from "./sessionBeliefs";
import { normalizeTokenUsage } from "./sessionUsage";
import {
  SESSION_REGISTRY_INSTANCE_NAME,
  type SessionMetadataInput,
} from "./sessionRegistry";
import { SessionSseHub } from "./sse";

export class SessionDurableObject implements DurableObject {
  private readonly state: DurableObjectState;
  /** Optional only to keep small unit-test state mocks free of Worker bindings. */
  private readonly env?: Pick<Env, "SESSION_REGISTRY">;
  /** Ephemeral live subscribers; persisted batches remain the source of truth. */
  private readonly sse = new SessionSseHub();

  constructor(state: DurableObjectState, env?: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // POST /store-beliefs - append one batch of beliefs for this session.
    if (url.pathname === "/store-beliefs" && request.method === "POST") {
      const result = (await request.json()) as ExtractionResult;
      const stored: BeliefBatch[] = (await this.state.storage.get("beliefs")) || [];
      const usage = normalizeTokenUsage(result.usage);
      const batch: BeliefBatch = {
        beliefs: result.beliefs,
        rawText: result.rawText,
        timestamp: result.timestamp,
        ...(usage === undefined ? {} : { usage }),
        ...(typeof result.modelName === "string" && result.modelName.trim()
          ? { modelName: result.modelName.trim() }
          : {}),
        ...(result.provider === "openai" || result.provider === "anthropic"
          ? { provider: result.provider }
          : {}),
        ...(typeof result.messageCount === "number" &&
        Number.isFinite(result.messageCount) &&
        result.messageCount >= 0
          ? { messageCount: Math.trunc(result.messageCount) }
          : {}),
      };
      stored.push(batch);
      await this.state.storage.put("beliefs", stored);
      // Persist the human-readable session name so GET can echo it back
      // instead of the opaque DO id. Refresh on every write.
      if (result.sessionId) {
        await this.state.storage.put("sessionName", result.sessionId);
      }
      // Publish only after durable storage has accepted the whole batch. A
      // disconnected stream is isolated inside the hub and can never make a
      // successful timeline write fail.
      this.sse.publish(batch.beliefs);
      // The first successful batch creates the registry record; later writes
      // upsert current counters and timestamps. Registry failure is explicitly
      // non-fatal: the source-of-truth session timeline was already persisted.
      await this.syncSessionRegistry(result, stored);
      return new Response(JSON.stringify({ ok: true, count: result.beliefs.length }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // GET /sse - hold a live EventSource stream for beliefs stored after this
    // connection opens. The public Worker route validates the session id;
    // this per-session DO only needs to own subscription lifecycle.
    if (url.pathname === "/sse" && request.method === "GET") {
      return this.sse.subscribe(request.signal);
    }

    // GET /beliefs - return the flat chronological timeline for this session.
    if (url.pathname === "/beliefs" && request.method === "GET") {
      const stored: BeliefBatch[] = (await this.state.storage.get("beliefs")) || [];
      const sessionName = (await this.state.storage.get<string>("sessionName")) ?? null;
      // Fall back to a request hint (the id from the incoming path) when
      // nothing has been written yet. Never leak the opaque DO id.
      const hint = url.searchParams.get("sessionId");
      // Stored confidence is immutable. At read time, older batches receive
      // `0.9 ^ turnsAgo` decay (newest batch = zero turns ago).
      const beliefs = flattenBeliefBatches(stored, { decayByTurn: true });
      const sessionId = resolveSessionId(sessionName, hint);
      return new Response(JSON.stringify({ sessionId, beliefs }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // GET /usage - cumulative token totals across all model calls in the
    // session. Usage is stored per batch so exports can still inspect calls.
    if (url.pathname === "/usage" && request.method === "GET") {
      const stored: BeliefBatch[] = (await this.state.storage.get("beliefs")) || [];
      const sessionName = (await this.state.storage.get<string>("sessionName")) ?? null;
      const hint = url.searchParams.get("sessionId");
      return new Response(
        JSON.stringify({
          sessionId: resolveSessionId(sessionName, hint),
          usage: aggregateBatchUsage(stored),
          calls: stored.length,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // GET /export - complete state snapshot for the Worker export handlers.
    // Batches retain their original confidence and per-call usage. The flat
    // timeline applies the same age decay as GET /beliefs, so user-facing JSON
    // and Markdown exports match the normal session view without losing raw
    // data needed for a portable full-session dump.
    if (url.pathname === "/export" && request.method === "GET") {
      const stored: BeliefBatch[] = (await this.state.storage.get("beliefs")) || [];
      const sessionName = (await this.state.storage.get<string>("sessionName")) ?? null;
      const hint = url.searchParams.get("sessionId");
      return new Response(
        JSON.stringify({
          sessionId: resolveSessionId(sessionName, hint),
          beliefs: flattenBeliefBatches(stored, { decayByTurn: true }),
          batches: stored,
          usage: aggregateBatchUsage(stored),
          calls: stored.length,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response("Not Found", { status: 404 });
  }

  /** Best-effort metadata snapshot to the global SessionRegistry Durable Object. */
  private async syncSessionRegistry(
    result: ExtractionResult,
    stored: BeliefBatch[],
  ): Promise<void> {
    const registry = this.env?.SESSION_REGISTRY;
    const sessionId = typeof result.sessionId === "string" ? result.sessionId.trim() : "";
    if (!registry || !sessionId) return;

    const createdAt = firstStoredTimestamp(stored);
    const updatedAt = validTimestamp(result.timestamp);

    const metadata: SessionMetadataInput = {
      id: sessionId,
      sessionName: sessionId,
      // A stored batch is one delivered model response, which is the session
      // message count—not the current inbound `messages[]` history length.
      messageCount: stored.length,
      tokenUsage: aggregateBatchUsage(stored),
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(updatedAt === undefined ? {} : { updatedAt }),
      ...(typeof result.modelName === "string" ? { modelName: result.modelName } : {}),
      ...(result.provider === "openai" || result.provider === "anthropic"
        ? { provider: result.provider }
        : {}),
    };

    try {
      const id = registry.idFromName(SESSION_REGISTRY_INSTANCE_NAME);
      const stub = registry.get(id);
      const response = await stub.fetch("https://internal/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(metadata),
      });
      if (!response.ok) {
        console.error("axion: failed to register session metadata", response.status);
      }
    } catch (error) {
      console.error(
        "axion: session registry write threw",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

function validTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function firstStoredTimestamp(batches: readonly BeliefBatch[]): number | undefined {
  for (const batch of batches) {
    const timestamp = validTimestamp(batch?.timestamp);
    if (timestamp !== undefined) return timestamp;
  }
  return undefined;
}
