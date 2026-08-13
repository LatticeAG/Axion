/**
 * Session export handlers and deterministic report formatting.
 *
 * The registry is the global metadata index; the per-session Durable Object
 * remains the source of truth for individual model-call batches. Export joins
 * both so callers receive a complete, portable session record without making
 * storage internals public as a general-purpose API.
 */

import type { ExtractedBelief } from "../lens/types";
import type { BeliefBatch } from "../state/sessionBeliefs";
import type { CumulativeTokenUsage } from "../state/sessionUsage";
import type { SessionMetadata } from "../state/sessionRegistry";
import { getSessionRegistryStub } from "./sessions";
import type { Env } from "./types";

/** Registry pages, and bulk exports, are deliberately capped at this size. */
export const EXPORT_PAGE_SIZE = 20;

export type SessionExportFormat = "json" | "markdown";

/** Full state snapshot returned only by the owning Session Durable Object. */
export interface SessionStateExportSnapshot {
  sessionId: string;
  /** Timeline confidence is decayed by stored turn age, matching GET beliefs. */
  beliefs: ExtractedBelief[];
  /** Raw append-only call records, including original confidence and usage. */
  batches: BeliefBatch[];
  usage: CumulativeTokenUsage;
  calls: number;
}

/** Public single-session export shape. */
export interface SessionExport {
  metadata: SessionMetadata;
  sessionId: string;
  beliefs: ExtractedBelief[];
  batches: BeliefBatch[];
  usage: CumulativeTokenUsage;
  calls: number;
}

/** Public bulk-export response shape. */
export interface BulkSessionExport {
  sessions: SessionExport[];
  nextCursor: string | null;
}

interface RegistryPage {
  sessions: SessionMetadata[];
  nextCursor: string | null;
}

/**
 * Parse exactly one encoded session-id segment plus an export format.
 *
 * Keeping this stricter than a substring check prevents nested paths from
 * accidentally being sent to a Durable Object as a session id. Encoded slashes
 * are valid session-name characters and are decoded only after the segment
 * boundary has been established.
 */
export function parseSessionExportPath(
  pathname: string,
): { sessionId: string; format: SessionExportFormat } | null {
  const match = /^\/api\/sessions\/([^/]+)\/export\/(json|markdown)$/.exec(pathname);
  if (!match) return null;

  try {
    const sessionId = decodeURIComponent(match[1]!).trim();
    if (!sessionId) return null;
    return { sessionId, format: match[2]! as SessionExportFormat };
  } catch {
    return null;
  }
}

/** Handle GET /api/sessions/:id/export/json and /export/markdown. */
export async function fetchSessionExport(env: Env, pathname: string): Promise<Response> {
  const route = parseSessionExportPath(pathname);
  if (!route) return jsonError(400, "Invalid session export path");

  try {
    const [metadata, snapshot] = await Promise.all([
      fetchSessionMetadata(env, route.sessionId),
      fetchSessionStateSnapshot(env, route.sessionId),
    ]);
    const exported = joinSessionExport(metadata, snapshot);
    return formatSessionExport(exported, route.format, route.sessionId);
  } catch (error) {
    if (error instanceof InternalResponseError) {
      return forwardJsonResponse(error.response);
    }
    console.error(
      "axion: session export failed",
      error instanceof Error ? error.message : String(error),
    );
    return jsonError(502, "Failed to export session");
  }
}

/** Handle GET /api/export/all using the registry's existing opaque cursor. */
export async function fetchAllSessionsExport(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  try {
    const page = await fetchExportRegistryPage(env, url.searchParams.get("cursor"));
    // Promise.all preserves registry ordering, so the export is deterministic
    // even though per-session Durable Object reads run concurrently.
    const sessions = await Promise.all(
      page.sessions.map(async (metadata) =>
        joinSessionExport(
          metadata,
          await fetchSessionStateSnapshot(env, metadata.id),
        ),
      ),
    );
    const payload: BulkSessionExport = { sessions, nextCursor: page.nextCursor };
    return downloadJson(payload, "axion-sessions.json");
  } catch (error) {
    if (error instanceof InternalResponseError) {
      return forwardJsonResponse(error.response);
    }
    console.error(
      "axion: bulk session export failed",
      error instanceof Error ? error.message : String(error),
    );
    return jsonError(502, "Failed to export sessions");
  }
}

/** Join validated registry metadata and a validated session-state snapshot. */
export function joinSessionExport(
  metadata: SessionMetadata,
  snapshot: SessionStateExportSnapshot,
): SessionExport {
  return {
    metadata,
    // A stored session name wins when available, as it is the value clients
    // actually used. The registry id is the stable fallback for empty DOs.
    sessionId: snapshot.sessionId || metadata.id,
    beliefs: snapshot.beliefs,
    batches: snapshot.batches,
    usage: snapshot.usage,
    calls: snapshot.calls,
  };
}

/** Render the human-readable Markdown representation without clock-dependent data. */
export function renderSessionMarkdown(exported: SessionExport): string {
  const { metadata, usage } = exported;
  const lines = [
    "# Axion session report",
    "",
    "## Summary",
    "",
    `- Session ID: ${inlineCode(exported.sessionId)}`,
    `- Session name: ${escapeMarkdown(metadata.sessionName)}`,
    `- Provider: ${escapeMarkdown(metadata.provider)}`,
    `- Model: ${escapeMarkdown(metadata.modelName)}`,
    `- Created: ${formatTimestamp(metadata.createdAt)}`,
    `- Updated: ${formatTimestamp(metadata.updatedAt)}`,
    `- Captured calls: ${exported.calls}`,
    `- Registry message count: ${metadata.messageCount}`,
    "",
    "## Token usage",
    "",
    `- Prompt tokens: ${usage.prompt_tokens}`,
    `- Completion tokens: ${usage.completion_tokens}`,
    `- Total tokens: ${usage.total_tokens}`,
    "",
    "## Belief timeline",
    "",
  ];

  if (exported.beliefs.length === 0) {
    lines.push("No beliefs were extracted for this session.", "");
    return lines.join("\n");
  }

  for (const [index, belief] of exported.beliefs.entries()) {
    lines.push(
      `### ${index + 1}. ${escapeMarkdown(belief.type)} · ${formatPercent(belief.confidence)}`,
      "",
      `- Time: ${formatTimestamp(belief.timestamp)}`,
      `- Belief: ${escapeMarkdown(belief.belief)}`,
    );
    if (belief.evidence) {
      lines.push(`- Evidence: ${escapeMarkdown(belief.evidence)}`);
    }
    if (belief.actionTaken) {
      lines.push(`- Action taken: ${escapeMarkdown(belief.actionTaken)}`);
    }
    lines.push(`- Source line: ${belief.line}`, "");
  }

  return lines.join("\n");
}

/** Generate a stable, header-safe file name for a session download. */
export function sessionExportFilename(sessionId: string, format: SessionExportFormat): string {
  const normalized = sessionId
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const stem = normalized || "session";
  return `axion-session-${stem}.${format === "json" ? "json" : "md"}`;
}

async function fetchSessionMetadata(env: Env, sessionId: string): Promise<SessionMetadata> {
  const registryUrl = new URL(
    `https://session-registry.internal/session/${encodeURIComponent(sessionId)}`,
  );
  let response: Response;
  try {
    response = await getSessionRegistryStub(env).fetch(registryUrl.toString());
  } catch (error) {
    throw new Error(
      `session registry request failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!response.ok) throw new InternalResponseError(response);

  const payload = await readJson(response, "session registry metadata");
  if (!isSessionMetadata(payload)) {
    throw new Error("session registry returned invalid metadata");
  }
  return payload;
}

async function fetchSessionStateSnapshot(
  env: Env,
  sessionId: string,
): Promise<SessionStateExportSnapshot> {
  let response: Response;
  try {
    const id = env.SESSION.idFromName(sessionId);
    response = await env.SESSION.get(id).fetch(
      `https://internal/export?sessionId=${encodeURIComponent(sessionId)}`,
    );
  } catch (error) {
    throw new Error(
      `session state request failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!response.ok) throw new InternalResponseError(response);

  const payload = await readJson(response, "session state export");
  if (!isSessionStateExportSnapshot(payload)) {
    throw new Error("session state returned an invalid export snapshot");
  }
  return payload;
}

async function fetchExportRegistryPage(env: Env, cursor: string | null): Promise<RegistryPage> {
  const registryUrl = new URL("https://session-registry.internal/sessions");
  registryUrl.searchParams.set("limit", String(EXPORT_PAGE_SIZE));
  // Cursor values are already opaque and URL-safe at the registry boundary.
  if (cursor) registryUrl.searchParams.set("cursor", cursor);

  let response: Response;
  try {
    response = await getSessionRegistryStub(env).fetch(registryUrl.toString());
  } catch (error) {
    throw new Error(
      `session registry request failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!response.ok) throw new InternalResponseError(response);

  const payload = await readJson(response, "session registry page");
  if (!isRegistryPage(payload)) {
    throw new Error("session registry returned an invalid export page");
  }
  return payload;
}

function formatSessionExport(
  exported: SessionExport,
  format: SessionExportFormat,
  requestedSessionId: string,
): Response {
  const filename = sessionExportFilename(requestedSessionId, format);
  if (format === "markdown") {
    return downloadText(renderSessionMarkdown(exported), "text/markdown; charset=utf-8", filename);
  }
  return downloadJson(exported, filename);
}

function downloadJson(payload: unknown, filename: string): Response {
  return downloadText(JSON.stringify(payload), "application/json; charset=utf-8", filename);
}

function downloadText(body: string, contentType: string, filename: string): Response {
  return new Response(body, {
    headers: exportHeaders(contentType, filename),
  });
}

function exportHeaders(contentType: string, filename: string): Headers {
  return new Headers({
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
}

function forwardJsonResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function apiHeaders(contentType: string): Headers {
  return new Headers({
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: apiHeaders("application/json; charset=utf-8"),
  });
}

class InternalResponseError extends Error {
  constructor(readonly response: Response) {
    super(`Internal export request returned HTTP ${response.status}`);
  }
}

async function readJson(response: Response, source: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`${source} returned invalid JSON`);
  }
}

function isSessionMetadata(value: unknown): value is SessionMetadata {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    isFiniteNonNegative(value.createdAt) &&
    isFiniteNonNegative(value.updatedAt) &&
    typeof value.modelName === "string" &&
    typeof value.provider === "string" &&
    typeof value.sessionName === "string" &&
    isFiniteNonNegative(value.messageCount) &&
    isTokenUsage(value.tokenUsage)
  );
}

function isSessionStateExportSnapshot(value: unknown): value is SessionStateExportSnapshot {
  if (!isRecord(value)) return false;
  return (
    typeof value.sessionId === "string" &&
    Array.isArray(value.beliefs) &&
    Array.isArray(value.batches) &&
    isTokenUsage(value.usage) &&
    isFiniteNonNegative(value.calls)
  );
}

function isRegistryPage(value: unknown): value is RegistryPage {
  if (!isRecord(value) || !Array.isArray(value.sessions)) return false;
  return (
    value.sessions.every(isSessionMetadata) &&
    (value.nextCursor === null || typeof value.nextCursor === "string")
  );
}

function isTokenUsage(value: unknown): value is CumulativeTokenUsage {
  if (!isRecord(value)) return false;
  return (
    isFiniteNonNegative(value.prompt_tokens) &&
    isFiniteNonNegative(value.completion_tokens) &&
    isFiniteNonNegative(value.total_tokens)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function formatTimestamp(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "Unknown";
  try {
    return new Date(value).toISOString();
  } catch {
    return "Unknown";
  }
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function escapeMarkdown(value: unknown): string {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/[\r\n]+/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

function inlineCode(value: string): string {
  return `\`${value.replace(/`/g, "\\`")}\``;
}
