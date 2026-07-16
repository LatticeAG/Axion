/**
 * Tests for the SSE stream utilities: SseLineParser, parseSseData, and
 * teeResponseForExtraction. These exercise the actual streaming/tee logic
 * that the proxy relies on for zero-latency belief extraction.
 */
import { describe, it, expect } from "vitest";
import {
  parseSseData,
  parseAnthropicSseData,
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

describe("parseAnthropicSseData", () => {
  it("extracts text from a content_block_delta text_delta", () => {
    const payload = JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    });
    const r = parseAnthropicSseData(payload);
    expect(r.text).toBe("Hello");
    expect(r.done).toBe(false);
  });

  it("marks done=true on message_stop", () => {
    const r = parseAnthropicSseData(JSON.stringify({ type: "message_stop" }));
    expect(r.done).toBe(true);
    expect(r.text).toBe("");
  });

  it("ignores non-text deltas and other event types", () => {
    const inputJson = JSON.stringify({
      type: "content_block_delta",
      delta: { type: "input_json_delta", partial_json: "{" },
    });
    expect(parseAnthropicSseData(inputJson).text).toBe("");
    expect(
      parseAnthropicSseData(JSON.stringify({ type: "message_start" })).text
    ).toBe("");
    expect(parseAnthropicSseData("not json").text).toBe("");
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

  it("tees an Anthropic SSE stream and accumulates text_delta text", async () => {
    const sse =
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n\n' +
      'event: message_stop\n' +
      'data: {"type":"message_stop"}\n\n';
    const original = new Response(sse, {
      headers: { "content-type": "text/event-stream" },
    });
    const { response, accumulatedText } = teeResponseForExtraction(
      original,
      true,
      "anthropic"
    );

    expect(await response.text()).toBe(sse);
    expect(await accumulatedText).toBe("Hello world");
  });

  it("flushes trailing multi-byte UTF-8 split across chunk boundaries", async () => {
    // "é" is 0xC3 0xA9; split the two bytes across two stream chunks so the
    // decoder must hold the first byte until the final flush.
    const bytes = new TextEncoder().encode("café");
    const splitAt = bytes.length - 1; // last byte of the "é" sequence
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, splitAt));
        c.enqueue(bytes.slice(splitAt));
        c.close();
      },
    });
    const original = new Response(stream);
    const { response, accumulatedText } = teeResponseForExtraction(
      original,
      false
    );

    expect(await response.text()).toBe("café");
    expect(await accumulatedText).toBe("café");
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
    let controller!: ReadableStreamDefaultController<Uint8Array>;
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
