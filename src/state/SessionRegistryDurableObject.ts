/**
 * Global index of Axion sessions.
 *
 * SessionDurableObject instances own belief batches. This Durable Object owns
 * only compact metadata records, allowing the dashboard, search, and health
 * endpoints to discover sessions without scanning an unbounded namespace.
 *
 * Internal routes:
 *   POST /register                 idempotent metadata snapshot upsert
 *   GET  /sessions?cursor=&limit=  newest-first cursor page (limit <= 100)
 *   GET  /session/:id              one metadata record
 */

import {
  clampPageSize,
  normalizeSessionRecords,
  paginateSessions,
  parseSessionMetadataInput,
  upsertSession,
  type SessionMetadata,
} from "./sessionRegistry";

const SESSIONS_STORAGE_KEY = "sessions";

export class SessionRegistryDurableObject implements DurableObject {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/sessions") {
      return this.listSessions(url);
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

    const result = upsertSession(await this.readRecords(), input);
    await this.state.storage.put(SESSIONS_STORAGE_KEY, result.records);
    return jsonResponse(
      { created: result.created, session: result.session },
      result.created ? 201 : 200,
    );
  }

  private async readRecords(): Promise<SessionMetadata[]> {
    const stored = await this.state.storage.get<unknown>(SESSIONS_STORAGE_KEY);
    return normalizeSessionRecords(stored);
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
