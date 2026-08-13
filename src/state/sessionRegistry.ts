/**
 * Session registry data model and pure helpers.
 *
 * The registry is a single Durable Object which indexes the metadata for every
 * session Durable Object. Keeping the ordering, cursor encoding, and upsert
 * rules here makes the storage-backed implementation straightforward to test
 * without a Cloudflare runtime.
 */

/** Token usage accumulated for a session. All values are non-negative ints. */
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** A session record exposed by the session browser API. */
export interface SessionMetadata {
  id: string;
  createdAt: number;
  updatedAt: number;
  modelName: string;
  provider: string;
  sessionName: string;
  messageCount: number;
  tokenUsage: TokenUsage;
}

/** The snapshot a session writes to the registry after persisting a batch. */
export interface SessionMetadataInput {
  id: string;
  createdAt?: number;
  updatedAt?: number;
  modelName?: string;
  provider?: string;
  sessionName?: string;
  messageCount?: number;
  tokenUsage?: Partial<TokenUsage>;
}

/** Cursor-paginated registry result. */
export interface SessionRegistryPage {
  sessions: SessionMetadata[];
  nextCursor: string | null;
}

/** Public session-browser page size required by the V2 API. */
export const SESSION_PAGE_SIZE = 20;

/** Maximum internal page size, used by server-side consumers such as search. */
export const MAX_SESSION_PAGE_SIZE = 100;

/** Stable name for the singleton global SessionRegistry Durable Object. */
export const SESSION_REGISTRY_INSTANCE_NAME = "axion-session-registry";

/** A zero usage snapshot for a newly registered session. */
export const EMPTY_TOKEN_USAGE: TokenUsage = Object.freeze({
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
});

/**
 * Upsert a registry record from a complete session snapshot.
 *
 * The registry sees best-effort writes after a session batch has been stored.
 * Snapshots can therefore be retried or arrive slightly stale; counts and
 * timestamps are monotonic so a stale retry cannot move the record backwards.
 */
export function upsertSession(
  records: readonly SessionMetadata[],
  input: SessionMetadataInput,
  now: number = Date.now(),
): { records: SessionMetadata[]; session: SessionMetadata; created: boolean } {
  const id = normalizeRequiredString(input.id);
  if (!id) {
    throw new Error("Session metadata requires a non-empty id");
  }

  const existingIndex = records.findIndex((record) => record.id === id);
  const existing = existingIndex === -1 ? undefined : records[existingIndex];
  const created = !existing;
  const safeNow = normalizeTimestamp(now, Date.now());
  const requestedUpdatedAt = normalizeTimestamp(input.updatedAt, safeNow);

  const session: SessionMetadata = {
    id,
    createdAt: existing?.createdAt ?? normalizeTimestamp(input.createdAt, safeNow),
    updatedAt: existing
      ? Math.max(existing.updatedAt, requestedUpdatedAt)
      : requestedUpdatedAt,
    modelName: normalizeOptionalString(input.modelName) ?? existing?.modelName ?? "unknown",
    provider: normalizeOptionalString(input.provider) ?? existing?.provider ?? "unknown",
    sessionName:
      normalizeOptionalString(input.sessionName) ?? existing?.sessionName ?? id,
    messageCount: existing
      ? Math.max(existing.messageCount, normalizeCount(input.messageCount, existing.messageCount))
      : normalizeCount(input.messageCount, 0),
    tokenUsage: mergeTokenUsage(existing?.tokenUsage, input.tokenUsage),
  };

  const next = [...records];
  if (existingIndex === -1) next.push(session);
  else next[existingIndex] = session;

  return { records: next, session, created };
}

/** Return a copy ordered newest-first, with id as a deterministic tiebreaker. */
export function sortSessionsByUpdatedAt(
  records: readonly SessionMetadata[],
): SessionMetadata[] {
  return [...records].sort(
    (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
  );
}

/**
 * Encode a stable sort position as an opaque URL-safe cursor.
 *
 * JSON plus percent encoding avoids a dependency on Node's Buffer and works in
 * Workers, browsers, and Vitest. Consumers should treat this value as opaque.
 */
export function encodeSessionCursor(session: Pick<SessionMetadata, "updatedAt" | "id">): string {
  return encodeURIComponent(JSON.stringify([session.updatedAt, session.id]));
}

/** Decode a cursor produced by {@link encodeSessionCursor}, or return null. */
export function decodeSessionCursor(
  cursor: string | null | undefined,
): { updatedAt: number; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(cursor)) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [updatedAt, id] = parsed;
    if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return null;
    if (typeof id !== "string" || !id.trim()) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}

/**
 * Return one newest-first cursor page. A stale cursor resumes strictly after
 * its sort key, so records are not repeated when a row was updated between
 * page requests.
 */
export function paginateSessions(
  records: readonly SessionMetadata[],
  cursor?: string | null,
  requestedLimit: number = SESSION_PAGE_SIZE,
): SessionRegistryPage {
  const ordered = sortSessionsByUpdatedAt(records);
  const position = decodeSessionCursor(cursor);
  const limit = clampPageSize(requestedLimit);
  const afterCursor = position
    ? ordered.filter((session) => compareAfterCursor(session, position))
    : ordered;
  const sessions = afterCursor.slice(0, limit);
  const hasMore = afterCursor.length > sessions.length;
  const last = sessions.at(-1);

  return {
    sessions,
    nextCursor: hasMore && last ? encodeSessionCursor(last) : null,
  };
}

/** Clamp an internal query page size to a safe positive range. */
export function clampPageSize(value: number): number {
  if (!Number.isFinite(value)) return SESSION_PAGE_SIZE;
  return Math.max(1, Math.min(MAX_SESSION_PAGE_SIZE, Math.floor(value)));
}

/** Normalize untrusted registry reads without losing valid records. */
export function normalizeSessionRecords(value: unknown): SessionMetadata[] {
  if (!Array.isArray(value)) return [];

  const records: SessionMetadata[] = [];
  for (const candidate of value) {
    if (!isObject(candidate)) continue;
    const id = normalizeRequiredString(candidate.id);
    if (!id) continue;
    const safeNow = 0;
    records.push({
      id,
      createdAt: normalizeTimestamp(candidate.createdAt, safeNow),
      updatedAt: normalizeTimestamp(candidate.updatedAt, safeNow),
      modelName: normalizeOptionalString(candidate.modelName) ?? "unknown",
      provider: normalizeOptionalString(candidate.provider) ?? "unknown",
      sessionName: normalizeOptionalString(candidate.sessionName) ?? id,
      messageCount: normalizeCount(candidate.messageCount, 0),
      tokenUsage: mergeTokenUsage(undefined, asTokenUsage(candidate.tokenUsage)),
    });
  }
  return records;
}

/** Read an object-shaped registry write payload without trusting its fields. */
export function parseSessionMetadataInput(value: unknown): SessionMetadataInput | null {
  if (!isObject(value)) return null;
  const id = normalizeRequiredString(value.id);
  if (!id) return null;

  return {
    id,
    createdAt: asFiniteNumber(value.createdAt),
    updatedAt: asFiniteNumber(value.updatedAt),
    modelName: asString(value.modelName),
    provider: asString(value.provider),
    sessionName: asString(value.sessionName),
    messageCount: asFiniteNumber(value.messageCount),
    tokenUsage: asTokenUsage(value.tokenUsage),
  };
}

function compareAfterCursor(
  session: SessionMetadata,
  cursor: { updatedAt: number; id: string },
): boolean {
  // Sort is updatedAt DESC then id ASC. "After" means lower updatedAt, or the
  // same timestamp with a lexicographically larger id.
  return (
    session.updatedAt < cursor.updatedAt ||
    (session.updatedAt === cursor.updatedAt && session.id.localeCompare(cursor.id) > 0)
  );
}

function mergeTokenUsage(
  existing: TokenUsage | undefined,
  incoming: Partial<TokenUsage> | undefined,
): TokenUsage {
  const previous = existing ?? EMPTY_TOKEN_USAGE;
  if (!incoming) return { ...previous };
  return {
    prompt_tokens: Math.max(
      previous.prompt_tokens,
      normalizeCount(incoming.prompt_tokens, previous.prompt_tokens),
    ),
    completion_tokens: Math.max(
      previous.completion_tokens,
      normalizeCount(incoming.completion_tokens, previous.completion_tokens),
    ),
    total_tokens: Math.max(
      previous.total_tokens,
      normalizeCount(incoming.total_tokens, previous.total_tokens),
    ),
  };
}

function normalizeRequiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeOptionalString(value: unknown): string | null {
  return normalizeRequiredString(value);
}

function normalizeTimestamp(value: unknown, fallback: number): number {
  const number = asFiniteNumber(value);
  return number !== undefined && number >= 0 ? number : fallback;
}

function normalizeCount(value: unknown, fallback: number): number {
  const number = asFiniteNumber(value);
  if (number === undefined || number < 0) return fallback;
  return Math.floor(number);
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asTokenUsage(value: unknown): Partial<TokenUsage> | undefined {
  if (!isObject(value)) return undefined;
  return {
    prompt_tokens: asFiniteNumber(value.prompt_tokens),
    completion_tokens: asFiniteNumber(value.completion_tokens),
    total_tokens: asFiniteNumber(value.total_tokens),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
