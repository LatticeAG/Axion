/**
 * Cross-session belief search endpoint.
 *
 * SessionRegistry owns the ordered metadata index while each session Durable
 * Object owns its belief timeline. This handler walks registry pages lazily,
 * loading only enough session timelines to fill the requested result page.
 */

import type { ExtractedBelief } from "../lens/types.js";
import {
  beliefMatchesSearch,
  decodeSearchCursor,
  encodeSearchCursor,
  isExtractedBelief,
  isSearchSessionMetadata,
  parseSearchFilters,
  searchFingerprint,
  sortSearchSessions,
  sortSessionBeliefs,
  type SearchCursorState,
  type SearchResult,
  type SearchSessionMetadata,
} from "../state/search.js";
import type { Env } from "./types";
import { getSessionRegistryStub, SESSION_REGISTRY_NAME } from "./sessions";

export { SESSION_REGISTRY_NAME };
export const REGISTRY_PAGE_SIZE = 20;

interface RegistryPage {
  sessions: SearchSessionMetadata[];
  nextCursor?: string;
}

/**
 * Handle GET /api/search.
 *
 * Response shape:
 * `{ results: [{ session, belief }], nextCursor: string | null }`.
 * A non-null cursor is opaque and can only be reused with the same q/type/
 * confidence filters (the requested limit may change between pages).
 */
export async function fetchSearch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const parsed = parseSearchFilters(url.searchParams);
  if (!parsed.ok) return jsonError(400, parsed.message);

  const fingerprint = searchFingerprint(parsed.filters);
  let state: SearchCursorState;
  if (parsed.cursor) {
    const decoded = decodeSearchCursor(parsed.cursor, parsed.filters);
    if (!decoded.ok) return jsonError(400, decoded.message);
    state = decoded.state;
  } else {
    state = {
      version: 1,
      fingerprint,
      registryExhausted: false,
      pending: [],
    };
  }

  try {
    const page = await searchAcrossSessions(env, state, parsed.filters);
    return jsonResponse({
      results: page.results,
      nextCursor: page.nextCursor ?? null,
    });
  } catch (error) {
    console.error(
      "axion: cross-session search failed",
      error instanceof Error ? error.message : String(error)
    );
    return jsonError(502, "Failed to search session state");
  }
}

/**
 * Search forward from an already-validated state. Exported for focused tests
 * and for future alternate transports (for example, a CLI endpoint).
 */
export async function searchAcrossSessions(
  env: Env,
  initialState: SearchCursorState,
  filters: Parameters<typeof beliefMatchesSearch>[1]
): Promise<{ results: SearchResult[]; nextCursor?: string }> {
  const state = cloneCursorState(initialState);
  const results: SearchResult[] = [];
  const seenRegistryCursors = new Set<string>();

  while (results.length < filters.limit) {
    if (state.pending.length === 0) {
      if (state.registryExhausted) break;

      const page = await fetchRegistryPage(env, state.registryCursor);
      if (state.registryCursor) seenRegistryCursors.add(state.registryCursor);
      if (page.nextCursor && seenRegistryCursors.has(page.nextCursor)) {
        throw new Error("Session registry returned a repeated cursor");
      }

      state.pending = sortSearchSessions(page.sessions).map((session) => ({
        session,
        beliefOffset: 0,
      }));
      state.registryCursor = page.nextCursor;
      state.registryExhausted = !page.nextCursor;

      // An empty non-final page is unusual but valid; keep walking rather than
      // treating it as the end of a potentially sparse registry scan.
      if (state.pending.length === 0) continue;
    }

    const current = state.pending[0]!;
    const beliefs = await fetchSessionBeliefs(env, current.session.id);
    const orderedBeliefs = sortSessionBeliefs(beliefs);

    for (let index = current.beliefOffset; index < orderedBeliefs.length; index++) {
      current.beliefOffset = index + 1;
      const belief = orderedBeliefs[index]!;
      if (!beliefMatchesSearch(belief, filters)) continue;

      results.push({ session: current.session, belief });
      if (results.length === filters.limit) {
        // If this hit consumed the session, discard it now so a final page does
        // not advertise a cursor which can only produce an empty response.
        if (current.beliefOffset >= orderedBeliefs.length) state.pending.shift();
        return {
          results,
          nextCursor: hasSearchContinuation(state) ? encodeSearchCursor(state) : undefined,
        };
      }
    }

    // The timeline was fully scanned without filling this result page.
    state.pending.shift();
  }

  return { results };
}

async function fetchRegistryPage(env: Env, cursor?: string): Promise<RegistryPage> {
  const stub = getSessionRegistryStub(env);
  const url = new URL("https://session-registry.internal/sessions");
  url.searchParams.set("limit", String(REGISTRY_PAGE_SIZE));
  if (cursor) url.searchParams.set("cursor", cursor);

  let response: Response;
  try {
    response = await stub.fetch(url.toString());
  } catch (error) {
    throw new Error(
      `Session registry request failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!response.ok) {
    throw new Error(`Session registry returned HTTP ${response.status}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Session registry returned invalid JSON");
  }
  if (!isRecord(payload) || !Array.isArray(payload.sessions)) {
    throw new Error("Session registry returned an invalid page");
  }

  const sessions: SearchSessionMetadata[] = [];
  for (const candidate of payload.sessions) {
    if (!isSearchSessionMetadata(candidate)) {
      throw new Error("Session registry returned invalid metadata");
    }
    sessions.push(candidate);
  }

  const rawNextCursor = payload.nextCursor;
  if (rawNextCursor === undefined || rawNextCursor === null) return { sessions };
  if (typeof rawNextCursor !== "string" || !rawNextCursor.trim()) {
    throw new Error("Session registry returned an invalid cursor");
  }
  return { sessions, nextCursor: rawNextCursor };
}

async function fetchSessionBeliefs(env: Env, sessionId: string): Promise<ExtractedBelief[]> {
  let response: Response;
  try {
    const id = env.SESSION.idFromName(sessionId);
    const stub = env.SESSION.get(id);
    response = await stub.fetch(
      `https://internal/beliefs?sessionId=${encodeURIComponent(sessionId)}`
    );
  } catch (error) {
    throw new Error(
      `Session ${sessionId} request failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (!response.ok) throw new Error(`Session ${sessionId} returned HTTP ${response.status}`);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Session ${sessionId} returned invalid JSON`);
  }
  if (!isRecord(payload) || !Array.isArray(payload.beliefs)) {
    throw new Error(`Session ${sessionId} returned an invalid belief timeline`);
  }

  const beliefs: ExtractedBelief[] = [];
  for (const candidate of payload.beliefs) {
    if (!isExtractedBelief(candidate)) {
      throw new Error(`Session ${sessionId} returned an invalid belief`);
    }
    beliefs.push(candidate);
  }
  return beliefs;
}

function hasSearchContinuation(state: SearchCursorState): boolean {
  return state.pending.length > 0 || !state.registryExhausted;
}

function cloneCursorState(state: SearchCursorState): SearchCursorState {
  return {
    version: state.version,
    fingerprint: state.fingerprint,
    registryCursor: state.registryCursor,
    registryExhausted: state.registryExhausted,
    pending: state.pending.map(({ session, beliefOffset }) => ({
      session: {
        ...session,
        tokenUsage: { ...session.tokenUsage },
      },
      beliefOffset,
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
