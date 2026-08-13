/**
 * Pure helpers for the cross-session belief search API.
 *
 * Search deliberately uses an opaque, query-bound cursor.  The cursor retains
 * the registry page that is currently being scanned and the belief offset in
 * its first unprocessed session.  That lets the Worker resume an expensive
 * cross-session search without re-scanning sessions already returned to the
 * caller.
 */

import type { BeliefType, ExtractedBelief } from "../lens/types.js";
import type { SessionMetadata } from "./sessionRegistry.js";

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 100;
export const SEARCH_CURSOR_VERSION = 1;

/** Metadata attached to every result so callers can identify its session. */
export type SearchSessionMetadata = SessionMetadata;

/** Parsed and validated filters accepted by GET /api/search. */
export interface SearchFilters {
  q: string;
  type?: BeliefType;
  minConfidence?: number;
  maxConfidence?: number;
  limit: number;
}

/** One belief returned by the search endpoint with its owning session. */
export interface SearchResult {
  session: SearchSessionMetadata;
  belief: ExtractedBelief;
}

/** A registry entry still to be searched when a page ends. */
export interface SearchCursorPendingSession {
  session: SearchSessionMetadata;
  /** Index into that session's descending-by-time belief list. */
  beliefOffset: number;
}

/** Internal payload encoded into the opaque API cursor. */
export interface SearchCursorState {
  version: typeof SEARCH_CURSOR_VERSION;
  /** Prevents accidental reuse of a cursor with a different query/filter set. */
  fingerprint: string;
  /** Registry cursor to use after `pending` has been consumed. */
  registryCursor?: string;
  /** True once the registry has confirmed that there are no later pages. */
  registryExhausted: boolean;
  pending: SearchCursorPendingSession[];
}

export type ParseSearchFiltersResult =
  | { ok: true; filters: SearchFilters; cursor?: string }
  | { ok: false; message: string };

export type DecodeSearchCursorResult =
  | { ok: true; state: SearchCursorState }
  | { ok: false; message: string };

const BELIEF_TYPES = new Set<string>([
  "causal",
  "assumption",
  "intention",
  "evidence",
  "uncertainty",
  "contradiction",
  "planning",
  "self-correction",
]);

/**
 * Parse the public query-string contract. Query terms are case-insensitive,
 * but the original trimmed term is retained for a readable API echo/debugger.
 */
export function parseSearchFilters(params: URLSearchParams): ParseSearchFiltersResult {
  const rawQuery = params.get("q");
  const q = rawQuery?.trim() ?? "";
  if (!q) {
    return { ok: false, message: 'Query parameter "q" is required' };
  }

  const rawType = params.get("type");
  let type: BeliefType | undefined;
  if (rawType !== null) {
    const normalizedType = rawType.trim().toLowerCase();
    if (!BELIEF_TYPES.has(normalizedType)) {
      return { ok: false, message: `Unknown belief type: ${rawType}` };
    }
    // BELIEF_TYPES is the runtime contract. The assertion keeps this helper
    // forward-compatible with the lens union while preserving validation.
    type = normalizedType as BeliefType;
  }

  const min = parseConfidence(params, "minConfidence");
  if (!min.ok) return min;
  const max = parseConfidence(params, "maxConfidence");
  if (!max.ok) return max;
  if (min.value !== undefined && max.value !== undefined && min.value > max.value) {
    return {
      ok: false,
      message: '"minConfidence" cannot be greater than "maxConfidence"',
    };
  }

  const rawLimit = params.get("limit");
  let limit = DEFAULT_SEARCH_LIMIT;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_SEARCH_LIMIT) {
      return {
        ok: false,
        message: `"limit" must be an integer between 1 and ${MAX_SEARCH_LIMIT}`,
      };
    }
    limit = parsed;
  }

  const rawCursor = params.get("cursor");
  if (rawCursor !== null && !rawCursor.trim()) {
    return { ok: false, message: '"cursor" must not be empty' };
  }

  return {
    ok: true,
    filters: {
      q,
      type,
      minConfidence: min.value,
      maxConfidence: max.value,
      limit,
    },
    cursor: rawCursor?.trim() || undefined,
  };
}

/** A stable value bound into every cursor, excluding the page-size knob. */
export function searchFingerprint(filters: Omit<SearchFilters, "limit"> | SearchFilters): string {
  return JSON.stringify({
    q: filters.q.trim().toLowerCase(),
    type: filters.type ?? null,
    minConfidence: filters.minConfidence ?? null,
    maxConfidence: filters.maxConfidence ?? null,
  });
}

/** Encode a validated cursor state as URL-safe base64 JSON. */
export function encodeSearchCursor(state: SearchCursorState): string {
  return toBase64Url(JSON.stringify(state));
}

/**
 * Decode and validate an opaque cursor. Its filter fingerprint must equal the
 * current request's fingerprint; otherwise returning a page could silently
 * skip or duplicate results.
 */
export function decodeSearchCursor(
  cursor: string,
  filters: Omit<SearchFilters, "limit"> | SearchFilters
): DecodeSearchCursorResult {
  if (cursor.length > 16_384) {
    return { ok: false, message: "Search cursor is too large" };
  }

  let value: unknown;
  try {
    value = JSON.parse(fromBase64Url(cursor));
  } catch {
    return { ok: false, message: "Invalid search cursor" };
  }

  if (!isRecord(value) || value.version !== SEARCH_CURSOR_VERSION) {
    return { ok: false, message: "Invalid search cursor" };
  }
  if (typeof value.fingerprint !== "string" || value.fingerprint !== searchFingerprint(filters)) {
    return { ok: false, message: "Search cursor does not match this query" };
  }
  if (
    value.registryCursor !== undefined &&
    (typeof value.registryCursor !== "string" || !value.registryCursor)
  ) {
    return { ok: false, message: "Invalid search cursor" };
  }
  if (typeof value.registryExhausted !== "boolean") {
    return { ok: false, message: "Invalid search cursor" };
  }
  if (!Array.isArray(value.pending) || value.pending.length > MAX_SEARCH_LIMIT) {
    return { ok: false, message: "Invalid search cursor" };
  }

  const pending: SearchCursorPendingSession[] = [];
  for (const candidate of value.pending) {
    if (!isRecord(candidate) || !isSearchSessionMetadata(candidate.session)) {
      return { ok: false, message: "Invalid search cursor" };
    }
    const beliefOffset = candidate.beliefOffset;
    if (
      typeof beliefOffset !== "number" ||
      !Number.isSafeInteger(beliefOffset) ||
      beliefOffset < 0
    ) {
      return { ok: false, message: "Invalid search cursor" };
    }
    pending.push({
      session: candidate.session,
      beliefOffset,
    });
  }

  return {
    ok: true,
    state: {
      version: SEARCH_CURSOR_VERSION,
      fingerprint: value.fingerprint,
      registryCursor: value.registryCursor,
      registryExhausted: value.registryExhausted,
      pending,
    },
  };
}

/** Whether a single belief matches every active text/type/confidence filter. */
export function beliefMatchesSearch(belief: ExtractedBelief, filters: SearchFilters): boolean {
  if (filters.type && belief.type !== filters.type) return false;
  if (
    filters.minConfidence !== undefined &&
    (!Number.isFinite(belief.confidence) || belief.confidence < filters.minConfidence)
  ) {
    return false;
  }
  if (
    filters.maxConfidence !== undefined &&
    (!Number.isFinite(belief.confidence) || belief.confidence > filters.maxConfidence)
  ) {
    return false;
  }

  const needle = filters.q.trim().toLowerCase();
  const beliefText = typeof belief.belief === "string" ? belief.belief : "";
  const evidenceText = typeof belief.evidence === "string" ? belief.evidence : "";
  return `${beliefText}\n${evidenceText}`.toLowerCase().includes(needle);
}

/**
 * Sort a session's beliefs newest first, breaking ties by stable id. The copy
 * means callers can safely pass data directly from Durable Object storage.
 */
export function sortSessionBeliefs(beliefs: readonly ExtractedBelief[]): ExtractedBelief[] {
  return [...beliefs].sort((left, right) => {
    const timestampDelta = safeTimestamp(right.timestamp) - safeTimestamp(left.timestamp);
    if (timestampDelta !== 0) return timestampDelta;
    return left.id.localeCompare(right.id);
  });
}

/** Sort registry entries in the same deterministic order as public browsing. */
export function sortSearchSessions(
  sessions: readonly SearchSessionMetadata[]
): SearchSessionMetadata[] {
  return [...sessions].sort((left, right) => {
    const timestampDelta = safeTimestamp(right.updatedAt) - safeTimestamp(left.updatedAt);
    if (timestampDelta !== 0) return timestampDelta;
    return left.id.localeCompare(right.id);
  });
}

/** Runtime guard used at the Worker boundary when parsing registry responses. */
export function isSearchSessionMetadata(value: unknown): value is SearchSessionMetadata {
  if (!isRecord(value) || !isRecord(value.tokenUsage)) return false;
  return (
    isNonEmptyString(value.id) &&
    Number.isFinite(value.createdAt) &&
    Number.isFinite(value.updatedAt) &&
    typeof value.modelName === "string" &&
    typeof value.provider === "string" &&
    typeof value.sessionName === "string" &&
    Number.isFinite(value.messageCount) &&
    Number.isFinite(value.tokenUsage.prompt_tokens) &&
    Number.isFinite(value.tokenUsage.completion_tokens) &&
    Number.isFinite(value.tokenUsage.total_tokens)
  );
}

/** Runtime guard for untrusted JSON returned by a session Durable Object. */
export function isExtractedBelief(value: unknown): value is ExtractedBelief {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    typeof value.sessionId === "string" &&
    BELIEF_TYPES.has(typeof value.type === "string" ? value.type : "") &&
    typeof value.belief === "string" &&
    Number.isFinite(value.confidence) &&
    Number.isFinite(value.timestamp) &&
    typeof value.rawText === "string" &&
    Number.isFinite(value.line) &&
    (value.evidence === undefined || typeof value.evidence === "string") &&
    (value.actionTaken === undefined || typeof value.actionTaken === "string")
  );
}

function parseConfidence(
  params: URLSearchParams,
  key: "minConfidence" | "maxConfidence"
): { ok: true; value?: number } | { ok: false; message: string } {
  const raw = params.get(key);
  if (raw === null) return { ok: true };
  if (!raw.trim()) {
    return { ok: false, message: `"${key}" must be a number between 0 and 1` };
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return { ok: false, message: `"${key}" must be a number between 0 and 1` };
  }
  return { ok: true, value: parsed };
}

function safeTimestamp(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("not base64url");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
