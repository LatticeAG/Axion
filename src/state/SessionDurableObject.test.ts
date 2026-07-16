/**
 * Tests for SessionDurableObject using an in-memory mock of DurableObjectState.
 * Exercises the store → flatten GET round trip and, critically, that GET
 * returns the human-readable sessionName rather than the opaque DO id.
 */
import { describe, it, expect } from "vitest";
import { SessionDurableObject } from "./SessionDurableObject";
import type { ExtractionResult } from "../proxy/types";
import type { ExtractedBelief } from "../lens/types";

function belief(id: string): ExtractedBelief {
  return {
    id,
    sessionId: "ignored",
    type: "causal",
    belief: `belief-${id}`,
    confidence: 0.7,
    timestamp: 0,
    rawText: "",
    line: 1,
  };
}

function makeResult(sessionId: string, ids: string[]): ExtractionResult {
  return { sessionId, beliefs: ids.map(belief), rawText: "raw", timestamp: Date.now() };
}

/** Minimal in-memory DurableObjectState stand-in. */
function makeState(idString = "opaque-do-id-abc123") {
  const store = new Map<string, unknown>();
  return {
    id: { toString: () => idString },
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => {
        store.set(key, value);
      },
    },
  } as unknown as DurableObjectState;
}

function post(session: string, ids: string[]): Request {
  return new Request("https://internal/store-beliefs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(makeResult(session, ids)),
  });
}

describe("SessionDurableObject", () => {
  it("stores batches and returns a flat chronological list on GET", async () => {
    const doInstance = new SessionDurableObject(makeState());

    await doInstance.fetch(post("my-session", ["a", "b"]));
    await doInstance.fetch(post("my-session", ["c"]));

    const res = await doInstance.fetch(new Request("https://internal/beliefs"));
    const body = (await res.json()) as { sessionId: string; beliefs: ExtractedBelief[] };

    expect(body.beliefs.map((b) => b.id)).toEqual(["a", "b", "c"]);
  });

  it("returns the stored human sessionName, not the DO id", async () => {
    const doInstance = new SessionDurableObject(makeState("opaque-do-id-abc123"));
    await doInstance.fetch(post("human-friendly-name", ["a"]));

    const res = await doInstance.fetch(new Request("https://internal/beliefs"));
    const body = (await res.json()) as { sessionId: string };

    expect(body.sessionId).toBe("human-friendly-name");
    expect(body.sessionId).not.toBe("opaque-do-id-abc123");
  });

  it("falls back to the request hint before any write", async () => {
    const doInstance = new SessionDurableObject(makeState());

    const res = await doInstance.fetch(
      new Request("https://internal/beliefs?sessionId=hint-name")
    );
    const body = (await res.json()) as { sessionId: string; beliefs: ExtractedBelief[] };

    expect(body.sessionId).toBe("hint-name");
    expect(body.beliefs).toEqual([]);
  });

  it("prefers the stored sessionName over the request hint", async () => {
    const doInstance = new SessionDurableObject(makeState());
    await doInstance.fetch(post("stored-name", ["a"]));

    const res = await doInstance.fetch(
      new Request("https://internal/beliefs?sessionId=hint-name")
    );
    const body = (await res.json()) as { sessionId: string };

    expect(body.sessionId).toBe("stored-name");
  });

  it("404s on unknown routes", async () => {
    const doInstance = new SessionDurableObject(makeState());
    const res = await doInstance.fetch(new Request("https://internal/nope"));
    expect(res.status).toBe(404);
  });
});
