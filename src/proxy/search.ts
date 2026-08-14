/**
 * Cross-session belief search endpoint.
 *
 * SessionRegistry owns the ordered metadata index while each session Durable
 * Object owns its belief timeline. This handler walks registry pages lazily,
 * loading only enough session timelines to fill the requested result page,
 * and stops at AXION_SEARCH_MAX_SESSION_SCANS so a broad query cannot walk
 * every session Durable Object in one request.
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
  SEARCH_CURSOR_VERSION,
  type SearchCursorPendingSession,
  type SearchCursorState,
  type SearchResult,
  type SearchSessionMetadata,
} from "../state/search.js";
import type { Env } from "./types";
import { getSessionRegistryStub, SESSION_REGISTRY_NAME } from "./sessions";
import { jsonErrorResponse, jsonResponse } from "./cors";
import { requireReadAuth } from "./readAuth";
import { enforceReadRateLimit } from "./rateLimit";

export { SESSION_REGISTRY_NAME };
export const REGISTRY_PAGE_SIZE = 20;
export const DEFAULT_SEARCH_MAX_SESSION_SCANS = 40;
const MIN_SEARCH_MAX_SESSION_SCANS = 1;
const MAX_SEARCH_MAX_SESSION_SCANS = 200;

interface RegistryPage {
  sessions: SearchSessionMetadata[];
  nextCursor?: string;
}

interface WorkingPendingSession {
  session: SearchSessionMetadata;
  beliefOffset: number;
  /** True once this session has consumed a G18 scan slot in this request. */
  charged: boolean;
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
  const auth = requireReadAuth(request, env);
  if (!auth.ok) return auth.response;

  const limited = await enforceReadRateLimit(request, env, "search");
  if (limited) return limited;

  const secret = env.AXION_CURSOR_SECRET?.trim() ?? "";
  if (!secret) {
    return jsonErrorResponse(request, env, 503, "Search cursor signing is not configured");
  }

  const url = new URL(request.url);
  const parsed = parseSearchFilters(url.searchParams);
  if (!parsed.ok) return jsonErrorResponse(request, env, 400, parsed.message);

  const fingerprint = searchFingerprint(parsed.filters);
  let state: SearchCursorState;
  if (parsed.cursor) {
    const decoded = await decodeSearchCursor(parsed.cursor, parsed.filters, secret);
    if (!decoded.ok) return jsonErrorResponse(request, env, 400, decoded.message);
    state = decoded.state;
  } else {
    state = {
      version: SEARCH_CURSOR_VERSION,
      fingerprint,
      registryExhausted: false,
      pending: [],
    };
  }

  try {
    const page = await searchAcrossSessions(env, state, parsed.filters);
    return jsonResponse(
      request,
      env,
      {
        results: page.results,
        nextCursor: page.nextCursor ?? null,
      },
      { headers: { "x-axion-scans": String(page.scans) } },
    );
  } catch (error) {
    console.error(
      "axion: cross-session search failed",
      error instanceof Error ? error.message : String(error)
    );
    return jsonErrorResponse(request, env, 502, "Failed to search session state");
  }
}

/** Parse AXION_SEARCH_MAX_SESSION_SCANS, default 40, clamped to [1, 200]. */
export function parseSearchMaxSessionScans(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_SEARCH_MAX_SESSION_SCANS;
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_SEARCH_MAX_SESSION_SCANS;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) return DEFAULT_SEARCH_MAX_SESSION_SCANS;
  if (parsed < MIN_SEARCH_MAX_SESSION_SCANS) return MIN_SEARCH_MAX_SESSION_SCANS;
  if (parsed > MAX_SEARCH_MAX_SESSION_SCANS) return MAX_SEARCH_MAX_SESSION_SCANS;
  return parsed;
}

/**
 * Search forward from an already-validated state. Exported for focused tests
 * and for future alternate transports (for example, a CLI endpoint).
 */
export async function searchAcrossSessions(
  env: Env,
  initialState: SearchCursorState,
  filters: Parameters<typeof beliefMatchesSearch>[1]
): Promise<{ results: SearchResult[]; nextCursor?: string; scans: number }> {
  const secret = env.AXION_CURSOR_SECRET?.trim() ?? "";
  if (!secret) {
    throw new Error("Search cursor signing is not configured");
  }

  const maxScans = parseSearchMaxSessionScans(env.AXION_SEARCH_MAX_SESSION_SCANS);
  let scans = 0;
  const unhydrated: SearchCursorPendingSession[] = [];
  const working: WorkingPendingSession[] = [];

  for (let index = 0; index < initialState.pending.length; index++) {
    const ref = initialState.pending[index]!;
    if (scans >= maxScans) {
      unhydrated.push(...initialState.pending.slice(index));
      break;
    }
    const session = await fetchRegistrySession(env, ref.id);
    scans += 1;
    if (session) {
      working.push({ session, beliefOffset: ref.beliefOffset, charged: true });
    }
  }

  const results: SearchResult[] = [];
  const seenRegistryCursors = new Set<string>();
  let registryCursor = initialState.registryCursor;
  let registryExhausted = initialState.registryExhausted;

  const encodeState = (): SearchCursorState => ({
    version: SEARCH_CURSOR_VERSION,
    fingerprint: initialState.fingerprint,
    registryCursor,
    registryExhausted,
    pending: [
      ...working.map((entry) => ({
        id: entry.session.id,
        beliefOffset: entry.beliefOffset,
      })),
      ...unhydrated,
    ],
  });

  const hasContinuation = (): boolean =>
    working.length > 0 || unhydrated.length > 0 || !registryExhausted;

  const maybeCursor = async (): Promise<string | undefined> => {
    if (!hasContinuation()) return undefined;
    return encodeSearchCursor(encodeState(), secret);
  };

  while (results.length < filters.limit) {
    if (working.length === 0) {
      if (unhydrated.length > 0) break;
      if (registryExhausted) break;
      if (scans >= maxScans) break;

      const page = await fetchRegistryPage(env, registryCursor);
      if (registryCursor) seenRegistryCursors.add(registryCursor);
      if (page.nextCursor && seenRegistryCursors.has(page.nextCursor)) {
        throw new Error("Session registry returned a repeated cursor");
      }

      working.push(
        ...sortSearchSessions(page.sessions).map((session) => ({
          session,
          beliefOffset: 0,
          charged: false,
        })),
      );
      registryCursor = page.nextCursor;
      registryExhausted = !page.nextCursor;

      // An empty non-final page is unusual but valid; keep walking rather than
      // treating it as the end of a potentially sparse registry scan.
      if (working.length === 0) continue;
    }

    const current = working[0]!;
    if (!current.charged) {
      if (scans >= maxScans) break;
      scans += 1;
      current.charged = true;
    }

    const beliefs = await fetchSessionBeliefs(env, current.session.id);
    const orderedBeliefs = sortSessionBeliefs(beliefs);

    let filled = false;
    for (let index = current.beliefOffset; index < orderedBeliefs.length; index++) {
      current.beliefOffset = index + 1;
      const belief = orderedBeliefs[index]!;
      if (!beliefMatchesSearch(belief, filters)) continue;

      results.push({
        session: current.session,
        belief: { ...belief, rawText: "" },
      });
      if (results.length === filters.limit) {
        // If this hit consumed the session, discard it now so a final page does
        // not advertise a cursor which can only produce an empty response.
        if (current.beliefOffset >= orderedBeliefs.length) working.shift();
        filled = true;
        break;
      }
    }

    if (filled) {
      return {
        results,
        nextCursor: await maybeCursor(),
        scans,
      };
    }

    // The timeline was fully scanned without filling this result page.
    working.shift();
  }

  return {
    results,
    nextCursor: await maybeCursor(),
    scans,
  };
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

async function fetchRegistrySession(
  env: Env,
  sessionId: string,
): Promise<SearchSessionMetadata | null> {
  const stub = getSessionRegistryStub(env);
  const url = new URL("https://internal/session");
  url.searchParams.set("id", sessionId);

  let response: Response;
  try {
    response = await stub.fetch(url.toString());
  } catch (error) {
    throw new Error(
      `Session registry request failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Session registry returned HTTP ${response.status}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Session registry returned invalid JSON");
  }
  if (!isSearchSessionMetadata(payload)) {
    throw new Error("Session registry returned invalid metadata");
  }
  return payload;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
