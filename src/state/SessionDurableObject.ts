/**
 * Axion Lens - Session state Durable Object (sharded timeline store).
 *
 * Beliefs are an append-only chronological timeline, not a graph. Each
 * POST /store-beliefs call appends one batch (the beliefs extracted from a
 * single response) as `batch:NNNNNN` plus a `meta` counter. GET /beliefs
 * flattens every batch into one ordered list and returns the public shape
 * `{ sessionId, beliefs: ExtractedBelief[], actions: ObservedAction[] }`.
 *
 * The `sessionId` returned is the human-readable session name (the value the
 * caller passed via `x-axion-session`, stored on `meta.sessionName`), never
 * the opaque Durable Object id.
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
  flattenBatchActions,
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
import {
  BATCH_LIST_RANGE,
  batchesFromList,
  clampMaxBeliefBatches,
  emptySessionMeta,
  incrementWebhookFailures,
  isSessionMeta,
  LEGACY_BELIEFS_KEY,
  LEGACY_SESSION_NAME_KEY,
  migrateLegacyBatches,
  planAppendBatch,
  prepareBeliefBatch,
  SESSION_META_KEY,
  type SessionMeta,
} from "./sessionStore";

export class SessionDurableObject implements DurableObject {
  private readonly state: DurableObjectState;
  /** Optional only to keep small unit-test state mocks free of Worker bindings. */
  private readonly env?: Pick<Env, "SESSION_REGISTRY" | "AXION_MAX_BELIEF_BATCHES">;
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
      const usage = normalizeTokenUsage(result.usage);
      const prepared = prepareBeliefBatch({
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
        ...inboundMessageCountField(result),
        ...redactionsField(result),
        actions: Array.isArray(result.actions) ? result.actions : [],
      });
      const stored = await this.appendBatch(prepared.batch, result.sessionId);
      // Publish only after durable storage has accepted the whole batch. A
      // disconnected stream is isolated inside the hub and can never make a
      // successful timeline write fail.
      this.sse.publish(prepared.batch.beliefs);
      // The first successful batch creates the registry record; later writes
      // upsert current counters and timestamps. Registry failure is explicitly
      // non-fatal: the source-of-truth session timeline was already persisted.
      await this.syncSessionRegistry(result, stored);
      return new Response(
        JSON.stringify({
          ok: true,
          count: result.beliefs.length,
          callsInSession: stored.length,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // POST /webhook-failure - best-effort counter after a failed sink delivery.
    if (url.pathname === "/webhook-failure" && request.method === "POST") {
      await this.bumpWebhookFailures();
      return new Response(JSON.stringify({ ok: true }), {
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
      const { batches, sessionName } = await this.loadTimeline();
      // Fall back to a request hint (the id from the incoming path) when
      // nothing has been written yet. Never leak the opaque DO id.
      const hint = url.searchParams.get("sessionId");
      // Stored confidence is immutable. At read time, older batches receive
      // `0.9 ^ turnsAgo` decay (newest batch = zero turns ago).
      const beliefs = flattenBeliefBatches(batches, { decayByTurn: true });
      const actions = flattenBatchActions(batches);
      const sessionId = resolveSessionId(sessionName, hint);
      return new Response(JSON.stringify({ sessionId, beliefs, actions }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // GET /usage - cumulative token totals across all model calls in the
    // session. Usage is stored per batch so exports can still inspect calls.
    if (url.pathname === "/usage" && request.method === "GET") {
      const { batches, sessionName } = await this.loadTimeline();
      const hint = url.searchParams.get("sessionId");
      return new Response(
        JSON.stringify({
          sessionId: resolveSessionId(sessionName, hint),
          usage: aggregateBatchUsage(batches),
          calls: batches.length,
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
      const { batches, sessionName } = await this.loadTimeline();
      const hint = url.searchParams.get("sessionId");
      return new Response(
        JSON.stringify({
          sessionId: resolveSessionId(sessionName, hint),
          beliefs: flattenBeliefBatches(batches, { decayByTurn: true }),
          batches,
          usage: aggregateBatchUsage(batches),
          calls: batches.length,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response("Not Found", { status: 404 });
  }

  /**
   * Append one prepared batch. Batch key and meta counter are written in a
   * single storage transaction so a crash cannot leave a dangling counter.
   */
  private async appendBatch(batch: BeliefBatch, sessionId?: string): Promise<BeliefBatch[]> {
    const maxBatches = clampMaxBeliefBatches(this.env?.AXION_MAX_BELIEF_BATCHES);
    let stored: BeliefBatch[] = [];
    await this.state.storage.transaction(async (txn) => {
      const loaded = await loadTimelineFromStorage(txn);
      let meta = loaded.meta ?? emptySessionMeta(loaded.sessionName);
      if (loaded.legacyBatches) {
        const migrated = migrateLegacyBatches(loaded.legacyBatches, meta.sessionName);
        if (Object.keys(migrated.entries).length > 0) {
          await txn.put(migrated.entries);
        }
        await txn.delete(LEGACY_BELIEFS_KEY);
        meta = migrated.meta;
      }
      if (sessionId) {
        meta = { ...meta, sessionName: sessionId };
      }
      const plan = planAppendBatch(meta, batch, maxBatches);
      await txn.put(plan.putKey, plan.putValue);
      await txn.put(SESSION_META_KEY, plan.meta);
      if (plan.deleteKey) await txn.delete(plan.deleteKey);
      stored = applyPlan(loaded.batches, plan);
    });
    return stored;
  }

  private async bumpWebhookFailures(): Promise<void> {
    await this.state.storage.transaction(async (txn) => {
      const loaded = await loadTimelineFromStorage(txn);
      const meta = loaded.meta ?? emptySessionMeta(loaded.sessionName);
      await txn.put(SESSION_META_KEY, incrementWebhookFailures(meta));
    });
  }

  private async loadTimeline(): Promise<{ batches: BeliefBatch[]; sessionName: string }> {
    const loaded = await loadTimelineFromStorage(this.state.storage);
    return { batches: loaded.batches, sessionName: loaded.sessionName };
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
      // message count, not the current inbound `messages[]` history length.
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

interface TimelineStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  list<T = unknown>(options?: { start?: string; end?: string; prefix?: string }): Promise<Map<string, T>>;
  put<T>(key: string, value: T): Promise<void>;
  put<T>(entries: Record<string, T>): Promise<void>;
  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
}

interface LoadedTimeline {
  batches: BeliefBatch[];
  sessionName: string;
  meta: SessionMeta | null;
  legacyBatches?: BeliefBatch[];
}

async function loadTimelineFromStorage(storage: TimelineStorage): Promise<LoadedTimeline> {
  const metaValue = await storage.get(SESSION_META_KEY);
  const legacyName = await storage.get(LEGACY_SESSION_NAME_KEY);
  const fallbackName = typeof legacyName === "string" ? legacyName : "";
  if (isSessionMeta(metaValue)) {
    const listed = await storage.list({
      start: BATCH_LIST_RANGE.start,
      end: BATCH_LIST_RANGE.end,
    });
    return {
      batches: batchesFromList(metaValue, listed),
      sessionName: metaValue.sessionName || fallbackName,
      meta: metaValue,
    };
  }

  const legacy = await storage.get(LEGACY_BELIEFS_KEY);
  const legacyBatches = Array.isArray(legacy) ? (legacy as BeliefBatch[]) : undefined;
  return {
    batches: legacyBatches ?? [],
    sessionName: fallbackName,
    meta: fallbackName ? emptySessionMeta(fallbackName) : null,
    ...(legacyBatches ? { legacyBatches } : {}),
  };
}

function applyPlan(
  previous: BeliefBatch[],
  plan: ReturnType<typeof planAppendBatch>,
): BeliefBatch[] {
  const next = plan.deleteKey ? previous.slice(1) : [...previous];
  next.push(plan.putValue);
  return next;
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

/** Persist inbound array length from the dedicated field, else messageCount. */
function inboundMessageCountField(
  result: ExtractionResult,
): Pick<BeliefBatch, "inboundMessageCount"> | Record<string, never> {
  const inbound = optionalNonNegativeInt(result.inboundMessageCount)
    ?? optionalNonNegativeInt(result.messageCount);
  return inbound === undefined ? {} : { inboundMessageCount: inbound };
}

function redactionsField(
  result: ExtractionResult,
): Pick<BeliefBatch, "redactions"> | Record<string, never> {
  const redactions = optionalNonNegativeInt(result.redactions);
  return redactions === undefined ? {} : { redactions };
}

function optionalNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}
