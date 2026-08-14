import { describe, expect, it } from "vitest";
import type { ExtractedBelief } from "../lens/types";
import type { SessionMetadata } from "./sessionRegistry";
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
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
  type SearchFilters,
} from "./search";

function filters(overrides: Partial<SearchFilters> = {}): SearchFilters {
  return {
    q: "token",
    limit: 20,
    ...overrides,
  };
}

function session(id: string, updatedAt = 100): SessionMetadata {
  return {
    id,
    createdAt: updatedAt - 1,
    updatedAt,
    modelName: "gpt-test",
    provider: "openai",
    sessionName: `Run ${id}`,
    messageCount: 1,
    tokenUsage: {
      prompt_tokens: 2,
      completion_tokens: 3,
      total_tokens: 5,
    },
  };
}

function belief(
  id: string,
  overrides: Partial<ExtractedBelief> = {},
): ExtractedBelief {
  return {
    id,
    sessionId: "session-a",
    type: "causal",
    belief: "The token expired",
    confidence: 0.7,
    timestamp: 100,
    rawText: "Because the token expired.",
    line: 1,
    ...overrides,
  };
}

function cursorState(overrides: Partial<SearchCursorState> = {}): SearchCursorState {
  const activeFilters = filters();
  return {
    version: 1,
    fingerprint: searchFingerprint(activeFilters),
    registryExhausted: false,
    pending: [{ id: "session-a", beliefOffset: 2 }],
    ...overrides,
  };
}

const CURSOR_SECRET = "test-cursor-secret";

describe("parseSearchFilters", () => {
  it("parses a required query with the V2 default limit", () => {
    const result = parseSearchFilters(new URLSearchParams("q=token"));

    expect(result).toEqual({
      ok: true,
      filters: {
        q: "token",
        type: undefined,
        minConfidence: undefined,
        maxConfidence: undefined,
        limit: DEFAULT_SEARCH_LIMIT,
      },
      cursor: undefined,
    });
  });

  it("accepts every public filter and normalizes a type", () => {
    const result = parseSearchFilters(
      new URLSearchParams(
        "q=%20Database%20&type=SELF-CORRECTION&minConfidence=0.25&maxConfidence=0.9&limit=7&cursor=opaque",
      ),
    );

    expect(result).toEqual({
      ok: true,
      filters: {
        q: "Database",
        type: "self-correction",
        minConfidence: 0.25,
        maxConfidence: 0.9,
        limit: 7,
      },
      cursor: "opaque",
    });
  });

  it("requires a non-blank q parameter", () => {
    expect(parseSearchFilters(new URLSearchParams())).toEqual({
      ok: false,
      message: 'Query parameter "q" is required',
    });
    expect(parseSearchFilters(new URLSearchParams("q=%20%20"))).toEqual({
      ok: false,
      message: 'Query parameter "q" is required',
    });
  });

  it("rejects unknown belief types", () => {
    const result = parseSearchFilters(new URLSearchParams("q=x&type=made-up"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("Unknown belief type");
  });

  it("rejects malformed confidence bounds and inverted ranges", () => {
    for (const query of [
      "q=x&minConfidence=nope",
      "q=x&minConfidence=",
      "q=x&maxConfidence=1.1",
      "q=x&minConfidence=-0.01",
      "q=x&minConfidence=0.9&maxConfidence=0.2",
    ]) {
      expect(parseSearchFilters(new URLSearchParams(query)).ok).toBe(false);
    }
  });

  it("rejects unsafe, fractional, and out-of-range limits", () => {
    for (const query of [
      "q=x&limit=0",
      "q=x&limit=1.5",
      `q=x&limit=${MAX_SEARCH_LIMIT + 1}`,
      "q=x&limit=Infinity",
    ]) {
      expect(parseSearchFilters(new URLSearchParams(query)).ok).toBe(false);
    }
  });

  it("rejects an explicitly empty cursor", () => {
    expect(parseSearchFilters(new URLSearchParams("q=x&cursor=%20")).ok).toBe(false);
  });
});

describe("beliefMatchesSearch", () => {
  it("matches belief text case-insensitively", () => {
    expect(beliefMatchesSearch(belief("a"), filters({ q: "TOKEN" }))).toBe(true);
  });

  it("matches cited evidence as well as belief text", () => {
    const candidate = belief("a", {
      belief: "The request failed",
      evidence: "Gateway timeout in the production logs",
    });
    expect(beliefMatchesSearch(candidate, filters({ q: "TIMEOUT" }))).toBe(true);
  });

  it("requires a text match even when type and confidence match", () => {
    expect(beliefMatchesSearch(belief("a"), filters({ q: "database" }))).toBe(false);
  });

  it("applies exact type and inclusive confidence bounds", () => {
    const candidate = belief("a", { type: "planning", confidence: 0.5 });
    expect(
      beliefMatchesSearch(
        candidate,
        filters({ q: "token", type: "planning", minConfidence: 0.5, maxConfidence: 0.5 }),
      ),
    ).toBe(true);
    expect(
      beliefMatchesSearch(candidate, filters({ q: "token", type: "causal" })),
    ).toBe(false);
    expect(
      beliefMatchesSearch(candidate, filters({ q: "token", minConfidence: 0.5001 })),
    ).toBe(false);
  });
});

describe("search ordering", () => {
  it("orders sessions by update time then id", () => {
    const ordered = sortSearchSessions([
      session("z", 1),
      session("b", 2),
      session("a", 2),
    ]);
    expect(ordered.map((item) => item.id)).toEqual(["a", "b", "z"]);
  });

  it("orders session beliefs newest first then id", () => {
    const ordered = sortSessionBeliefs([
      belief("z", { timestamp: 10 }),
      belief("b", { timestamp: 20 }),
      belief("a", { timestamp: 20 }),
    ]);
    expect(ordered.map((item) => item.id)).toEqual(["a", "b", "z"]);
  });

  it("does not mutate caller-owned belief arrays while sorting", () => {
    const input = [belief("old", { timestamp: 1 }), belief("new", { timestamp: 2 })];
    const ordered = sortSessionBeliefs(input);
    expect(ordered).not.toBe(input);
    expect(input.map((item) => item.id)).toEqual(["old", "new"]);
  });
});

describe("opaque search cursors", () => {
  it("round-trips a current registry page and per-session offset", async () => {
    const state = cursorState({ registryCursor: "registry cursor / %", registryExhausted: false });
    const decoded = await decodeSearchCursor(
      await encodeSearchCursor(state, CURSOR_SECRET),
      filters(),
      CURSOR_SECRET,
    );

    expect(decoded).toEqual({ ok: true, state });
  });

  it("does not embed tokenUsage in the encoded cursor string", async () => {
    const encoded = await encodeSearchCursor(
      cursorState({ pending: [{ id: session("session-a").id, beliefOffset: 0 }] }),
      CURSOR_SECRET,
    );
    expect(encoded).not.toContain("tokenUsage");
    const decoded = await decodeSearchCursor(encoded, filters(), CURSOR_SECRET);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(JSON.stringify(decoded.state)).not.toContain("tokenUsage");
    }
  });

  it("permits a new page size but rejects a different query or filter", async () => {
    const encoded = await encodeSearchCursor(cursorState(), CURSOR_SECRET);
    expect((await decodeSearchCursor(encoded, filters({ limit: 3 }), CURSOR_SECRET)).ok).toBe(true);
    expect(await decodeSearchCursor(encoded, filters({ q: "different" }), CURSOR_SECRET)).toEqual({
      ok: false,
      message: "Search cursor does not match this query",
    });
    expect(await decodeSearchCursor(encoded, filters({ type: "causal" }), CURSOR_SECRET)).toEqual({
      ok: false,
      message: "Search cursor does not match this query",
    });
  });

  it("rejects malformed, unsigned, oversized, and structurally invalid cursors", async () => {
    expect((await decodeSearchCursor("not-base64!", filters(), CURSOR_SECRET)).ok).toBe(false);
    expect((await decodeSearchCursor("a".repeat(16_385), filters(), CURSOR_SECRET)).ok).toBe(false);

    const unsignedPayload = btoa('{"v":1}').replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    expect((await decodeSearchCursor(unsignedPayload, filters(), CURSOR_SECRET)).ok).toBe(false);

    const invalid = await encodeSearchCursor(
      {
        ...cursorState(),
        pending: [{ id: "a", beliefOffset: -1 }],
      },
      CURSOR_SECRET,
    );
    expect((await decodeSearchCursor(invalid, filters(), CURSOR_SECRET)).ok).toBe(false);
  });

  it("rejects a mismatched MAC", async () => {
    const encoded = await encodeSearchCursor(cursorState(), CURSOR_SECRET);
    const [payload, mac] = encoded.split(".");
    const tampered = `${payload!.slice(0, -1)}${payload!.endsWith("A") ? "B" : "A"}.${mac}`;
    expect((await decodeSearchCursor(tampered, filters(), CURSOR_SECRET)).ok).toBe(false);
    expect((await decodeSearchCursor(encoded, filters(), "other-secret")).ok).toBe(false);
  });
});

describe("search response guards", () => {
  it("accepts complete registry metadata and rejects partial metadata", () => {
    expect(isSearchSessionMetadata(session("a"))).toBe(true);
    expect(isSearchSessionMetadata({ id: "a", updatedAt: 1 })).toBe(false);
  });

  it("accepts full belief records including V2 types and rejects corrupt values", () => {
    expect(isExtractedBelief(belief("a", { type: "uncertainty" }))).toBe(true);
    expect(isExtractedBelief({ ...belief("a"), confidence: "0.7" })).toBe(false);
    expect(isExtractedBelief({ ...belief("a"), type: "unknown" })).toBe(false);
  });
});
