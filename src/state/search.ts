/**
 * Pure helpers for the cross-session belief search API.
 *
 * Search uses an opaque, query-bound cursor. The cursor stores the registry
 * page still to scan and the belief offset in each pending session id. Resume
 * rehydrates those ids from the registry so the wire payload never carries
 * SessionMetadata or token totals.
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

/** A registry entry still to be searched when a page ends. Compact on the wire. */
export interface SearchCursorPendingSession {
  id: string;
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

/** Cap on pending ids stored in one cursor, matching the G18 scan ceiling. */
export const MAX_CURSOR_PENDING = 200;

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

/**
 * Encode compact cursor state. Wire format is
 * `base64url(json).base64url(raw-hmac-bytes)` so the MAC is not JSON-embeddable.
 * HMAC-SHA256 uses AXION_CURSOR_SECRET only, never AXION_READ_TOKEN.
 */
export async function encodeSearchCursor(state: SearchCursorState, secret: string): Promise<string> {
  const trimmed = secret.trim();
  if (!trimmed) {
    throw new Error("Search cursor signing is not configured");
  }

  const payload: Record<string, unknown> = {
    v: SEARCH_CURSOR_VERSION,
    fp: state.fingerprint,
  };
  if (state.registryCursor) payload.rc = state.registryCursor;
  payload.rx = state.registryExhausted;
  payload.p = state.pending.map((entry) => ({ id: entry.id, o: entry.beliefOffset }));

  const jsonBytes = new TextEncoder().encode(JSON.stringify(payload));
  const mac = await hmacSha256(trimmed, jsonBytes);
  return `${toBase64UrlBytes(jsonBytes)}.${toBase64UrlBytes(mac)}`;
}

/**
 * Decode and validate a signed compact cursor. Its filter fingerprint must
 * equal the current request's fingerprint; otherwise returning a page could
 * silently skip or duplicate results. Unsigned or mismatched MACs are rejected.
 */
export async function decodeSearchCursor(
  cursor: string,
  filters: Omit<SearchFilters, "limit"> | SearchFilters,
  secret: string,
): Promise<DecodeSearchCursorResult> {
  const trimmedSecret = secret.trim();
  if (!trimmedSecret) {
    return { ok: false, message: "Search cursor signing is not configured" };
  }
  if (cursor.length > 16_384) {
    return { ok: false, message: "Search cursor is too large" };
  }

  const separator = cursor.indexOf(".");
  if (separator <= 0 || cursor.indexOf(".", separator + 1) !== -1) {
    return { ok: false, message: "Invalid search cursor" };
  }
  const payloadB64 = cursor.slice(0, separator);
  const macB64 = cursor.slice(separator + 1);
  if (!payloadB64 || !macB64) {
    return { ok: false, message: "Invalid search cursor" };
  }

  let jsonBytes: Uint8Array;
  let macBytes: Uint8Array;
  try {
    jsonBytes = fromBase64UrlBytes(payloadB64);
    macBytes = fromBase64UrlBytes(macB64);
  } catch {
    return { ok: false, message: "Invalid search cursor" };
  }

  const expectedMac = await hmacSha256(trimmedSecret, jsonBytes);
  if (!timingSafeEqualBytes(macBytes, expectedMac)) {
    return { ok: false, message: "Invalid search cursor" };
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(jsonBytes));
  } catch {
    return { ok: false, message: "Invalid search cursor" };
  }

  if (!isRecord(value) || value.v !== SEARCH_CURSOR_VERSION) {
    return { ok: false, message: "Invalid search cursor" };
  }
  if (typeof value.fp !== "string" || value.fp !== searchFingerprint(filters)) {
    return { ok: false, message: "Search cursor does not match this query" };
  }
  if (value.rc !== undefined && (typeof value.rc !== "string" || !value.rc)) {
    return { ok: false, message: "Invalid search cursor" };
  }
  if (typeof value.rx !== "boolean") {
    return { ok: false, message: "Invalid search cursor" };
  }
  if (!Array.isArray(value.p) || value.p.length > MAX_CURSOR_PENDING) {
    return { ok: false, message: "Invalid search cursor" };
  }

  const fingerprint = value.fp;
  const registryExhausted = value.rx;
  const registryCursor = typeof value.rc === "string" ? value.rc : undefined;
  const pending: SearchCursorPendingSession[] = [];
  for (const candidate of value.p) {
    if (!isRecord(candidate) || !isNonEmptyString(candidate.id)) {
      return { ok: false, message: "Invalid search cursor" };
    }
    const beliefOffset = candidate.o;
    if (
      typeof beliefOffset !== "number" ||
      !Number.isSafeInteger(beliefOffset) ||
      beliefOffset < 0
    ) {
      return { ok: false, message: "Invalid search cursor" };
    }
    pending.push({
      id: candidate.id,
      beliefOffset,
    });
  }

  return {
    ok: true,
    state: {
      version: SEARCH_CURSOR_VERSION,
      fingerprint,
      registryCursor,
      registryExhausted,
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

async function hmacSha256(secret: string, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, data);
  return new Uint8Array(signature);
}

function timingSafeEqualBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let diff = 0;
  for (let index = 0; index < left.byteLength; index++) {
    diff |= left[index]! ^ right[index]!;
  }
  return diff === 0;
}

function toBase64UrlBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64UrlBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("not base64url");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
