/**
 * Tests for the SSE stream utilities: SseLineParser, parseSseData, and
 * teeResponseForExtraction. These exercise the actual streaming/tee logic
 * that the proxy relies on for zero-latency belief extraction.
 */
import { describe, it, expect } from "vitest";
import {
  parseSseData,
  SseLineParser,
  teeResponseForExtraction,
} from "./stream";

describe("parseSseData", () => {
  it("returns done=true for the [DONE] sentinel", () => {
    const r = parseSseData("[DONE]");
    expect(r.done).toBe(true);
    expect(r.text).toBe("");
  });

  it("extracts delta.content from an OpenAI chunk", () => {
    const payload = JSON.stringify({
      choices: [{ delta: { content: "Hello" } }],
    });
    const r = parseSseData(payload);
    expect(r.text).toBe("Hello");
    expect(r.done).toBe(false);
  });

  it("handles content arrays with {text} parts", () => {
    const payload = JSON.stringify({
      choices: [
        { delta: { content: [{ text: "a" }, { text: "b" }, "c"] } },
      ],
    });
    const r = parseSseData(payload);
    expect(r.text).toBe("abc");
  });

  it("returns empty text for non-JSON or missing delta", () => {
    expect(parseSseData("not json").text).toBe("");
    expect(parseSseData(JSON.stringify({ choices: [] })).text).toBe("");
  });
});

describe("SseLineParser", () => {
  it("parses complete records delimited by \\n\\n", () => {
    const p = new SseLineParser();
    const out = p.feed('data: hello\n\n');
    expect(out).toEqual(["hello"]);
  });

  it("handles partial records across feeds", () => {
    const p = new SseLineParser();
    expect(p.feed("data: hel")).toEqual([]);
    expect(p.feed("lo\n\n")).toEqual(["hello"]);
  });

  it("parses multiple records in one chunk", () => {
    const p = new SseLineParser();
    const out = p.feed("data: one\n\ndata: two\n\n");
    expect(out).toEqual(["one", "two"]);
  });

  it("handles \\r\\n\\r\\n delimiters", () => {
    const p = new SseLineParser();
    const out = p.feed("data: win\r\n\r\n");
    expect(out).toEqual(["win"]);
  });

  it("strips comment lines and joins multi-line data", () => {
    const p = new SseLineParser();
    const out = p.feed(": keepalive\ndata: a\ndata: b\n\n");
    expect(out).toEqual(["a\nb"]);
  });

  it("flush returns trailing buffered record", () => {
    const p = new SseLineParser();
    p.feed("data: tail"); // no trailing delimiter
    expect(p.flush()).toEqual(["tail"]);
  });

  it("flush returns empty for whitespace-only buffer", () => {
    const p = new SseLineParser();
    p.feed("   ");
    expect(p.flush()).toEqual([]);
  });
});

describe("teeResponseForExtraction", () => {
  it("passes non-SSE body through untouched and accumulates raw text", async () => {
    const original = new Response("hello world");
    const { response, accumulatedText } = teeResponseForExtraction(original, false);

    // Caller branch should see the full body.
    const callerText = await response.text();
    expect(callerText).toBe("hello world");

    // Extraction branch should have accumulated the same text.
    expect(await accumulatedText).toBe("hello world");
  });

  it("tees an SSE stream and accumulates only delta text", async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n' +
      "data: [DONE]\n\n";
    const original = new Response(sse, {
      headers: { "content-type": "text/event-stream" },
    });
    const { response, accumulatedText } = teeResponseForExtraction(original, true);

    // Caller sees the raw SSE bytes untouched.
    const callerText = await response.text();
    expect(callerText).toBe(sse);

    // Extraction branch saw only the delta text.
    expect(await accumulatedText).toBe("Hello world");
  });

  it("handles a null body (returns empty accumulated text)", async () => {
    const original = new Response(null, { status: 204 });
    const { response, accumulatedText } = teeResponseForExtraction(original, false);
    expect(response.status).toBe(204);
    expect(await accumulatedText).toBe("");
  });

  it("streams concurrently: caller does not wait for extraction", async () => {
    // Build a slow stream that emits chunks over time.
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const original = new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    });
    const { response, accumulatedText } = teeResponseForExtraction(original, true);

    const callerChunks: string[] = [];
    const callerDone = (async () => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        callerChunks.push(decoder.decode(value, { stream: true }));
      }
    })();

    // Emit two SSE records, spaced out.
    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"b"}}]}\n\n'));
    controller.close();

    await Promise.all([callerDone, accumulatedText]);
    expect(await accumulatedText).toBe("ab");
    expect(callerChunks.join("")).toContain('data: {"choices":[{"delta":{"content":"a"}}]}');
  });
});
