import { describe, expect, it } from "vitest";
import type { ExtractedBelief } from "../lens/types";
import type { ExtractionResult } from "../proxy/types";
import { SessionDurableObject } from "./SessionDurableObject";

function makeState() {
  const values = new Map<string, unknown>();
  return {
    storage: {
      get: async <T>(key: string): Promise<T | undefined> => values.get(key) as T | undefined,
      put: async (key: string, value: unknown): Promise<void> => {
        values.set(key, value);
      },
    },
  } as unknown as DurableObjectState;
}

function belief(id: string): ExtractedBelief {
  return {
    id,
    sessionId: "stream-session",
    type: "evidence",
    belief: `trace ${id}`,
    evidence: `trace ${id}`,
    confidence: 0.6,
    timestamp: 10,
    rawText: `According to trace ${id}.`,
    line: 1,
  };
}

function store(beliefs: ExtractedBelief[]): Request {
  const result: ExtractionResult = {
    sessionId: "stream-session",
    beliefs,
    rawText: "model response",
    timestamp: 10,
  };
  return new Request("https://internal/store-beliefs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(result),
  });
}

describe("SessionDurableObject live SSE", () => {
  it("emits each belief in a persisted batch after a client subscribes", async () => {
    const session = new SessionDurableObject(makeState());
    const sseResponse = await session.fetch(new Request("https://internal/sse"));
    const reader = sseResponse.body!.getReader();

    const storeResponse = await session.fetch(store([belief("one"), belief("two")]));
    expect(storeResponse.status).toBe(200);
    expect(sseResponse.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");

    expect(new TextDecoder().decode((await reader.read()).value!)).toBe(
      `event: new-belief\ndata: ${JSON.stringify(belief("one"))}\n\n`,
    );
    expect(new TextDecoder().decode((await reader.read()).value!)).toBe(
      `event: new-belief\ndata: ${JSON.stringify(belief("two"))}\n\n`,
    );

    await reader.cancel();
  });

  it("stops a subscription safely when the internal request is aborted", async () => {
    const session = new SessionDurableObject(makeState());
    const abort = new AbortController();
    const stream = await session.fetch(
      new Request("https://internal/sse", { signal: abort.signal }),
    );
    const reader = stream.body!.getReader();

    abort.abort();
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    await expect(session.fetch(store([belief("after-disconnect")]))).resolves.toMatchObject({
      status: 200,
    });
  });
});
