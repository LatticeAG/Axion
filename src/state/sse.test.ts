import { describe, expect, it } from "vitest";
import type { ExtractedBelief } from "../lens/types";
import {
  formatNewBeliefEvent,
  SessionSseHub,
  SSE_RESPONSE_HEADERS,
} from "./sse";

function belief(id: string): ExtractedBelief {
  return {
    id,
    sessionId: "live-session",
    type: "causal",
    belief: `belief ${id}`,
    confidence: 0.7,
    timestamp: 42,
    rawText: `because belief ${id}`,
    line: 1,
  };
}

function decode(chunk: Uint8Array): string {
  return new TextDecoder().decode(chunk);
}

describe("formatNewBeliefEvent", () => {
  it("uses the exact named-event SSE wire format", () => {
    const entry = belief("one");
    expect(formatNewBeliefEvent(entry)).toBe(
      `event: new-belief\ndata: ${JSON.stringify(entry)}\n\n`,
    );
  });
});

describe("SessionSseHub", () => {
  it("opens an EventSource-compatible response and fans out every batch belief", async () => {
    const hub = new SessionSseHub();
    const first = hub.subscribe();
    const second = hub.subscribe();
    const firstReader = first.body!.getReader();
    const secondReader = second.body!.getReader();

    expect(first.headers.get("Content-Type")).toBe(
      SSE_RESPONSE_HEADERS["Content-Type"],
    );
    expect(first.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(first.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(hub.size).toBe(2);

    expect(hub.publish([belief("one"), belief("two")])).toBe(4);

    expect(decode((await firstReader.read()).value!)).toBe(
      formatNewBeliefEvent(belief("one")),
    );
    expect(decode((await firstReader.read()).value!)).toBe(
      formatNewBeliefEvent(belief("two")),
    );
    expect(decode((await secondReader.read()).value!)).toBe(
      formatNewBeliefEvent(belief("one")),
    );
    expect(decode((await secondReader.read()).value!)).toBe(
      formatNewBeliefEvent(belief("two")),
    );

    await firstReader.cancel();
    await secondReader.cancel();
  });

  it("detaches a cancelled stream and safely ignores later broadcasts", async () => {
    const hub = new SessionSseHub();
    const response = hub.subscribe();
    const reader = response.body!.getReader();

    await reader.cancel();
    expect(hub.size).toBe(0);
    expect(() => hub.publish([belief("after-cancel")])).not.toThrow();
    expect(hub.publish([belief("after-cancel")])).toBe(0);
  });

  it("cleans up request-aborted clients and closes their stream", async () => {
    const hub = new SessionSseHub();
    const abort = new AbortController();
    const response = hub.subscribe(abort.signal);
    const reader = response.body!.getReader();

    expect(hub.size).toBe(1);
    abort.abort();

    expect(hub.size).toBe(0);
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(hub.publish([belief("after-abort")])).toBe(0);
  });

  it("does not retain a request that was already aborted before subscribing", async () => {
    const hub = new SessionSseHub();
    const abort = new AbortController();
    abort.abort();

    const response = hub.subscribe(abort.signal);
    expect(hub.size).toBe(0);
    expect(await response.body!.getReader().read()).toEqual({
      done: true,
      value: undefined,
    });
  });
});
