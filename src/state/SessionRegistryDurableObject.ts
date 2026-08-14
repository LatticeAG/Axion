/**
 * Global index of Axion sessions.
 *
 * SessionDurableObject instances own belief batches. This Durable Object owns
 * only compact metadata records, allowing the dashboard, search, and health
 * endpoints to discover sessions without scanning an unbounded namespace.
 *
 * Records are stored as `sessions:<chunk>` of 100 plus `registryMeta`. A
 * legacy `"sessions"` array is served until a successful chunk migration.
 *
 * Internal routes:
 *   POST /register                 idempotent metadata snapshot upsert
 *   GET  /sessions?cursor=&limit=  newest-first cursor page (limit <= 100)
 *   GET  /session?id=              one metadata record
 *   GET  /session/:id              one metadata record
 */

import {
  clampPageSize,
  evictOldestSessions,
  isRegistryMeta,
  LEGACY_SESSIONS_KEY,
  MAX_REGISTRY_SESSIONS,
  normalizeSessionRecords,
  packRegistryChunks,
  paginateSessions,
  parseSessionMetadataInput,
  REGISTRY_META_KEY,
  registryChunkKey,
  unpackRegistryChunks,
  upsertSession,
  type RegistryMeta,
  type SessionMetadata,
} from "./sessionRegistry";

export class SessionRegistryDurableObject implements DurableObject {
  private readonly state: DurableObjectState;
  /** Set when chunk migration from the legacy array fails. Reads stay on that key. */
  private legacyFallback = false;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/sessions") {
      return this.listSessions(url);
    }

    if (request.method === "GET" && url.pathname === "/session") {
      return this.getSessionByQuery(url);
    }

    if (request.method === "GET" && url.pathname.startsWith("/session/")) {
      return this.getSession(url.pathname);
    }

    if (request.method === "POST" && url.pathname === "/register") {
      return this.registerSession(request);
    }

    return jsonResponse({ error: { message: "Not Found" } }, 404);
  }

  private async listSessions(url: URL): Promise<Response> {
    const rawLimit = url.searchParams.get("limit");
    const parsedLimit = rawLimit === null ? undefined : Number(rawLimit);
    const limit = parsedLimit === undefined ? undefined : clampPageSize(parsedLimit);
    const records = await this.readRecords();
    const page = paginateSessions(records, url.searchParams.get("cursor"), limit);

    return jsonResponse(page);
  }

  private async getSession(pathname: string): Promise<Response> {
    const id = extractPathSessionId(pathname);
    if (!id) {
      return jsonResponse({ error: { message: "Missing session ID in path" } }, 400);
    }
    return this.lookupSession(id);
  }

  private async getSessionByQuery(url: URL): Promise<Response> {
    const id = url.searchParams.get("id")?.trim() ?? "";
    if (!id) {
      return jsonResponse({ error: { message: "Missing session ID in query" } }, 400);
    }
    return this.lookupSession(id);
  }

  private async lookupSession(id: string): Promise<Response> {
    const session = (await this.readRecords()).find((record) => record.id === id);
    if (!session) {
      return jsonResponse({ error: { message: "Session not found" } }, 404);
    }
    return jsonResponse(session);
  }

  private async registerSession(request: Request): Promise<Response> {
    let input: ReturnType<typeof parseSessionMetadataInput>;
    try {
      input = parseSessionMetadataInput(await request.json());
    } catch {
      return jsonResponse({ error: { message: "Invalid JSON metadata payload" } }, 400);
    }

    if (!input) {
      return jsonResponse(
        { error: { message: "Session metadata requires a non-empty id" } },
        400,
      );
    }

    const loaded = await this.loadForWrite();
    const existing = loaded.records.some((record) => record.id === input.id);
    if (loaded.mode === "legacy" && !existing) {
      return jsonResponse(
        { error: { message: "Session registry cannot accept new registrations" } },
        503,
      );
    }

    const result = upsertSession(loaded.records, input);
    const records = evictOldestSessions(result.records, MAX_REGISTRY_SESSIONS);
    if (loaded.mode === "legacy") {
      await this.state.storage.put(LEGACY_SESSIONS_KEY, records);
    } else {
      await this.writeChunks(records, loaded.previousChunkCount);
    }

    return jsonResponse(
      { created: result.created, session: result.session },
      result.created ? 201 : 200,
    );
  }

  private async readRecords(): Promise<SessionMetadata[]> {
    if (this.legacyFallback) {
      return this.readLegacy();
    }
    const meta = await this.state.storage.get(REGISTRY_META_KEY);
    if (isRegistryMeta(meta)) {
      return this.readChunks(meta);
    }
    return this.readLegacy();
  }

  private async loadForWrite(): Promise<{
    records: SessionMetadata[];
    mode: "chunked" | "legacy";
    previousChunkCount: number;
  }> {
    if (this.legacyFallback) {
      return { records: await this.readLegacy(), mode: "legacy", previousChunkCount: 0 };
    }

    const meta = await this.state.storage.get(REGISTRY_META_KEY);
    if (isRegistryMeta(meta)) {
      return {
        records: await this.readChunks(meta),
        mode: "chunked",
        previousChunkCount: meta.chunkCount,
      };
    }

    const legacy = await this.state.storage.get(LEGACY_SESSIONS_KEY);
    if (legacy === undefined) {
      return { records: [], mode: "chunked", previousChunkCount: 0 };
    }

    const records = normalizeSessionRecords(legacy);
    try {
      await this.writeChunks(records, 0);
      return { records, mode: "chunked", previousChunkCount: packRegistryChunks(records).meta.chunkCount };
    } catch {
      this.legacyFallback = true;
      return { records, mode: "legacy", previousChunkCount: 0 };
    }
  }

  private async readLegacy(): Promise<SessionMetadata[]> {
    const stored = await this.state.storage.get(LEGACY_SESSIONS_KEY);
    return normalizeSessionRecords(stored);
  }

  private async readChunks(meta: RegistryMeta): Promise<SessionMetadata[]> {
    if (meta.chunkCount <= 0) return [];
    const keys = Array.from({ length: meta.chunkCount }, (_, index) => registryChunkKey(index));
    const listed = await this.state.storage.get(keys);
    return unpackRegistryChunks(meta, listed);
  }

  private async writeChunks(
    records: SessionMetadata[],
    previousChunkCount: number,
  ): Promise<void> {
    const packed = packRegistryChunks(records);
    await this.state.storage.transaction(async (txn) => {
      await txn.put(REGISTRY_META_KEY, packed.meta);
      if (Object.keys(packed.chunks).length > 0) {
        await txn.put(packed.chunks);
      }
      const stale: string[] = [LEGACY_SESSIONS_KEY];
      for (let index = packed.meta.chunkCount; index < previousChunkCount; index++) {
        stale.push(registryChunkKey(index));
      }
      await txn.delete(stale);
    });
  }
}

/** Extract exactly one URL path segment after `/session/`. */
export function extractPathSessionId(pathname: string): string | null {
  const prefix = "/session/";
  if (!pathname.startsWith(prefix)) return null;
  const encoded = pathname.slice(prefix.length);
  if (!encoded || encoded.includes("/")) return null;
  try {
    const id = decodeURIComponent(encoded).trim();
    return id || null;
  } catch {
    return null;
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
