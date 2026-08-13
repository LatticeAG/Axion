import { describe, expect, it } from "vitest";
import {
  MAX_SESSION_PAGE_SIZE,
  SESSION_PAGE_SIZE,
  clampPageSize,
  decodeSessionCursor,
  encodeSessionCursor,
  normalizeSessionRecords,
  paginateSessions,
  parseSessionMetadataInput,
  sortSessionsByUpdatedAt,
  upsertSession,
  type SessionMetadata,
} from "./sessionRegistry";

function session(
  id: string,
  updatedAt: number,
  overrides: Partial<SessionMetadata> = {},
): SessionMetadata {
  return {
    id,
    createdAt: updatedAt - 1,
    updatedAt,
    modelName: "gpt-test",
    provider: "openai",
    sessionName: id,
    messageCount: 1,
    tokenUsage: {
      prompt_tokens: 2,
      completion_tokens: 3,
      total_tokens: 5,
    },
    ...overrides,
  };
}

describe("upsertSession", () => {
  it("creates a complete metadata record with safe defaults", () => {
    const result = upsertSession([], { id: "session-a" }, 1_000);

    expect(result.created).toBe(true);
    expect(result.records).toHaveLength(1);
    expect(result.session).toEqual({
      id: "session-a",
      createdAt: 1_000,
      updatedAt: 1_000,
      modelName: "unknown",
      provider: "unknown",
      sessionName: "session-a",
      messageCount: 0,
      tokenUsage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    });
  });

  it("upserts snapshots without moving monotonic metadata backward", () => {
    const first = upsertSession(
      [],
      {
        id: "session-a",
        createdAt: 10,
        updatedAt: 20,
        modelName: "gpt-4.1",
        provider: "openai",
        sessionName: "Agent run",
        messageCount: 3,
        tokenUsage: {
          prompt_tokens: 11,
          completion_tokens: 13,
          total_tokens: 24,
        },
      },
      30,
    );
    const second = upsertSession(
      first.records,
      {
        id: "session-a",
        updatedAt: 15,
        messageCount: 2,
        tokenUsage: {
          prompt_tokens: 9,
          completion_tokens: 14,
          total_tokens: 23,
        },
      },
      40,
    );

    expect(second.created).toBe(false);
    expect(second.session.createdAt).toBe(10);
    expect(second.session.updatedAt).toBe(20);
    expect(second.session.messageCount).toBe(3);
    expect(second.session.modelName).toBe("gpt-4.1");
    expect(second.session.tokenUsage).toEqual({
      prompt_tokens: 11,
      completion_tokens: 14,
      total_tokens: 24,
    });
  });

  it("accepts later model/provider snapshots and trims string fields", () => {
    const first = upsertSession([], { id: "session-a" }, 10);
    const next = upsertSession(
      first.records,
      {
        id: " session-a ",
        updatedAt: 20,
        modelName: " claude-sonnet ",
        provider: " anthropic ",
        sessionName: " project run ",
        messageCount: 1,
      },
      20,
    );

    expect(next.records).toHaveLength(1);
    expect(next.session).toMatchObject({
      id: "session-a",
      updatedAt: 20,
      modelName: "claude-sonnet",
      provider: "anthropic",
      sessionName: "project run",
      messageCount: 1,
    });
  });

  it("rejects a missing id", () => {
    expect(() => upsertSession([], { id: "  " }, 1)).toThrow(/non-empty id/i);
  });
});

describe("registry ordering and cursors", () => {
  it("orders updated sessions newest first with an id tiebreaker", () => {
    const ordered = sortSessionsByUpdatedAt([
      session("z", 10),
      session("b", 20),
      session("a", 20),
    ]);

    expect(ordered.map((record) => record.id)).toEqual(["a", "b", "z"]);
  });

  it("round-trips a cursor containing special characters", () => {
    const cursor = encodeSessionCursor({ updatedAt: 123, id: "a / session?" });
    expect(decodeSessionCursor(cursor)).toEqual({
      updatedAt: 123,
      id: "a / session?",
    });
  });

  it("returns null for a malformed cursor", () => {
    expect(decodeSessionCursor("not-a-cursor")).toBeNull();
    expect(decodeSessionCursor(encodeURIComponent("not json"))).toBeNull();
  });

  it("paginates without duplicate records across a cursor boundary", () => {
    const records = Array.from({ length: 25 }, (_, index) =>
      session(`session-${String(index).padStart(2, "0")}`, 100 - index),
    );
    const first = paginateSessions(records);
    const second = paginateSessions(records, first.nextCursor);

    expect(first.sessions).toHaveLength(SESSION_PAGE_SIZE);
    expect(first.nextCursor).not.toBeNull();
    expect(second.sessions).toHaveLength(5);
    expect([...first.sessions, ...second.sessions].map((record) => record.id)).toEqual(
      sortSessionsByUpdatedAt(records).map((record) => record.id),
    );
    expect(second.nextCursor).toBeNull();
  });

  it("resumes after a stale cursor sort key instead of repeating rows", () => {
    const records = [session("a", 30), session("b", 20), session("c", 10)];
    const cursor = encodeSessionCursor(records[0]!);
    const page = paginateSessions(records, cursor, 20);

    expect(page.sessions.map((record) => record.id)).toEqual(["b", "c"]);
  });

  it("clamps internal page sizes", () => {
    expect(clampPageSize(-1)).toBe(1);
    expect(clampPageSize(0)).toBe(1);
    expect(clampPageSize(1.8)).toBe(1);
    expect(clampPageSize(MAX_SESSION_PAGE_SIZE + 1)).toBe(MAX_SESSION_PAGE_SIZE);
    expect(clampPageSize(Number.NaN)).toBe(SESSION_PAGE_SIZE);
  });
});

describe("untrusted registry values", () => {
  it("normalizes valid records and drops malformed entries", () => {
    const records = normalizeSessionRecords([
      {
        id: " valid ",
        createdAt: 1,
        updatedAt: 2,
        modelName: " model ",
        provider: " provider ",
        sessionName: " named ",
        messageCount: 3.9,
        tokenUsage: {
          prompt_tokens: 4,
          completion_tokens: 5,
          total_tokens: 9,
        },
      },
      null,
      { id: "" },
    ]);

    expect(records).toEqual([
      {
        id: "valid",
        createdAt: 1,
        updatedAt: 2,
        modelName: "model",
        provider: "provider",
        sessionName: "named",
        messageCount: 3,
        tokenUsage: {
          prompt_tokens: 4,
          completion_tokens: 5,
          total_tokens: 9,
        },
      },
    ]);
  });

  it("parses only object payloads with a non-empty id", () => {
    expect(parseSessionMetadataInput(null)).toBeNull();
    expect(parseSessionMetadataInput({ id: " " })).toBeNull();
    expect(
      parseSessionMetadataInput({
        id: "s",
        messageCount: 1,
        tokenUsage: { total_tokens: 2 },
      }),
    ).toEqual({
      id: "s",
      createdAt: undefined,
      updatedAt: undefined,
      modelName: undefined,
      provider: undefined,
      sessionName: undefined,
      messageCount: 1,
      tokenUsage: {
        prompt_tokens: undefined,
        completion_tokens: undefined,
        total_tokens: 2,
      },
    });
  });
});
