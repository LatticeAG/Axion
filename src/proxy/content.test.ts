/**
 * Tests for assistant text normalization: the OpenAI/Anthropic non-streaming
 * extractors and the transport-aware extractAssistantText dispatcher.
 */
import { describe, it, expect } from "vitest";
import {
  extractOpenAIAssistantText,
  extractAnthropicAssistantText,
  extractAssistantText,
} from "./content";

describe("extractOpenAIAssistantText", () => {
  it("reads string content from choices[0].message.content", () => {
    const body = JSON.stringify({
      choices: [{ message: { role: "assistant", content: "Hello world" } }],
    });
    expect(extractOpenAIAssistantText(body)).toBe("Hello world");
  });

  it("joins array content parts (text objects and bare strings)", () => {
    const body = JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "a" }, { text: "b" }, "c"],
          },
        },
      ],
    });
    expect(extractOpenAIAssistantText(body)).toBe("abc");
  });

  it("returns empty string for malformed JSON", () => {
    expect(extractOpenAIAssistantText("not json")).toBe("");
  });

  it("returns empty string when content is missing", () => {
    expect(extractOpenAIAssistantText(JSON.stringify({ choices: [] }))).toBe("");
    expect(extractOpenAIAssistantText(JSON.stringify({}))).toBe("");
  });
});

describe("extractAnthropicAssistantText", () => {
  it("joins content[] text blocks", () => {
    const body = JSON.stringify({
      content: [
        { type: "text", text: "Hello" },
        { type: "text", text: " world" },
      ],
    });
    expect(extractAnthropicAssistantText(body)).toBe("Hello world");
  });

  it("skips non-text blocks (e.g. tool_use)", () => {
    const body = JSON.stringify({
      content: [
        { type: "text", text: "before" },
        { type: "tool_use", id: "t1", name: "x", input: {} },
        { type: "text", text: " after" },
      ],
    });
    expect(extractAnthropicAssistantText(body)).toBe("before after");
  });

  it("returns empty string for malformed JSON or missing content", () => {
    expect(extractAnthropicAssistantText("nope")).toBe("");
    expect(extractAnthropicAssistantText(JSON.stringify({}))).toBe("");
  });
});

describe("extractAssistantText", () => {
  it("returns accumulated delta text as-is (trimmed) for SSE openai", () => {
    const out = extractAssistantText({
      provider: "openai",
      isSse: true,
      accumulated: "  streamed delta  ",
    });
    expect(out).toBe("streamed delta");
  });

  it("returns accumulated delta text as-is (trimmed) for SSE anthropic", () => {
    const out = extractAssistantText({
      provider: "anthropic",
      isSse: true,
      accumulated: "anthropic stream",
    });
    expect(out).toBe("anthropic stream");
  });

  it("parses non-SSE openai body via the OpenAI extractor", () => {
    const body = JSON.stringify({
      choices: [{ message: { content: "final answer" } }],
    });
    const out = extractAssistantText({
      provider: "openai",
      isSse: false,
      accumulated: body,
    });
    expect(out).toBe("final answer");
  });

  it("parses non-SSE anthropic body via the Anthropic extractor", () => {
    const body = JSON.stringify({
      content: [{ type: "text", text: "final answer" }],
    });
    const out = extractAssistantText({
      provider: "anthropic",
      isSse: false,
      accumulated: body,
    });
    expect(out).toBe("final answer");
  });
});
