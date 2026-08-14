import { describe, expect, it } from "vitest";
import { extractAnthropicAssistantText } from "./content";
import {
  canonicalJson,
  extractObservedActions,
  linkActionsToBeliefs,
  MAX_ARGUMENTS_REDACTED_CHARS,
  sha256Hex,
} from "./actions";
import { runExtraction } from "./extraction";
import type { Env, ExtractionResult } from "./types";

function makeEnv(received: ExtractionResult[]): Env {
  const stub = {
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      received.push(JSON.parse(String(init?.body)) as ExtractionResult);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  } as unknown as DurableObjectStub;

  return {
    SESSION: {
      idFromName: (name: string) => name as unknown as DurableObjectId,
      get: () => stub,
    },
  } as unknown as Env;
}

const OPENAI_TOOL_BODY = JSON.stringify({
  choices: [
    {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_lookup_1",
            type: "function",
            function: { name: "lookup", arguments: '{"q":"trace","n":1}' },
          },
        ],
      },
    },
  ],
});

const ANTHROPIC_TOOL_BODY = JSON.stringify({
  content: [
    { type: "text", text: "before" },
    { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "trace" } },
    { type: "text", text: " after" },
  ],
});

describe("extractObservedActions", () => {
  it("reads OpenAI non-stream tool_calls", async () => {
    const actions = await extractObservedActions({
      provider: "openai",
      isSse: false,
      raw: OPENAI_TOOL_BODY,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      id: "call_lookup_1",
      name: "lookup",
      provider: "openai",
      source: "tool_calls",
      sourceClass: "tool_observed",
      argumentFingerprintSource: "canonical",
    });
    expect(actions[0]?.argumentFingerprint).toBe(
      await sha256Hex(canonicalJson({ n: 1, q: "trace" })),
    );
    expect(actions[0]?.argumentsRedacted).toBeUndefined();
  });

  it("does not skip Anthropic tool_use when extracting actions", async () => {
    expect(extractAnthropicAssistantText(ANTHROPIC_TOOL_BODY)).toBe("before after");
    const actions = await extractObservedActions({
      provider: "anthropic",
      isSse: false,
      raw: ANTHROPIC_TOOL_BODY,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      id: "toolu_1",
      name: "lookup",
      provider: "anthropic",
      source: "tool_use",
      argumentFingerprintSource: "canonical",
    });
  });

  it("coalesces OpenAI streamed tool_calls by index", async () => {
    const raw = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]}}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const actions = await extractObservedActions({
      provider: "openai",
      isSse: true,
      raw,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]?.id).toBe("call_1");
    expect(actions[0]?.name).toBe("lookup");
    expect(actions[0]?.argumentFingerprintSource).toBe("canonical");
  });

  it("coalesces Anthropic input_json_delta fragments", async () => {
    const raw = [
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_9","name":"lookup","input":{}}}\n\n',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":"}}\n\n',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"x\\"}"}}\n\n',
      'data: {"type":"content_block_stop","index":1}\n\n',
    ].join("");
    const actions = await extractObservedActions({
      provider: "anthropic",
      isSse: true,
      raw,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]?.id).toBe("toolu_9");
    expect(actions[0]?.argumentFingerprintSource).toBe("canonical");
  });

  it("records malformed args with argumentFingerprintSource raw", async () => {
    const raw = JSON.stringify({
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "call_bad",
                function: { name: "lookup", arguments: "{not-json" },
              },
            ],
          },
        },
      ],
    });
    const actions = await extractObservedActions({
      provider: "openai",
      isSse: false,
      raw,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]?.argumentFingerprintSource).toBe("raw");
    expect(actions[0]?.argumentFingerprint).toBe(await sha256Hex("{not-json"));
    expect(actions[0]?.argumentBytes).toBe(new TextEncoder().encode("{not-json").byteLength);
  });

  it("fingerprints stably under object key reorder", async () => {
    const a = await extractObservedActions({
      provider: "openai",
      isSse: false,
      raw: JSON.stringify({
        choices: [
          {
            message: {
              tool_calls: [
                { id: "c1", function: { name: "lookup", arguments: '{"b":2,"a":1}' } },
              ],
            },
          },
        ],
      }),
    });
    const b = await extractObservedActions({
      provider: "openai",
      isSse: false,
      raw: JSON.stringify({
        choices: [
          {
            message: {
              tool_calls: [
                { id: "c1", function: { name: "lookup", arguments: '{"a":1,"b":2}' } },
              ],
            },
          },
        ],
      }),
    });
    expect(a[0]?.argumentFingerprint).toBe(b[0]?.argumentFingerprint);
    expect(a[0]?.argumentFingerprintSource).toBe("canonical");
  });
});

describe("linkActionsToBeliefs and runExtraction", () => {
  it("stamps actionTaken on a same-batch intention for OpenAI tool_calls", async () => {
    const received: ExtractionResult[] = [];
    const actions = await extractObservedActions({
      provider: "openai",
      isSse: false,
      raw: OPENAI_TOOL_BODY,
    });
    expect(actions).toHaveLength(1);
    await runExtraction(
      makeEnv(received),
      "session-tools",
      "I will inspect the logs.",
      { provider: "openai", actions },
    );
    expect(received).toHaveLength(1);
    expect(received[0]!.actions).toHaveLength(1);
    const intention = received[0]!.beliefs.find((b) => b.type === "intention");
    expect(intention?.actionTaken).toBe("lookup");
  });

  it("attaches to the last empty intention when several exist", () => {
    const linked = linkActionsToBeliefs(
      [
        { type: "intention", actionTaken: "" },
        { type: "planning", actionTaken: "" },
      ],
      [{ name: "lookup" } as never],
    );
    expect(linked[0]?.actionTaken).toBe("");
    expect(linked[1]?.actionTaken).toBe("lookup");
  });

  it("stores redacted arguments when storeArgs is true, capped at 2048 chars", async () => {
    const huge = `{"secret":"sk-ant-api03-TEST","q":"${"a".repeat(3000)}"}`;
    const raw = JSON.stringify({
      choices: [
        {
          message: {
            tool_calls: [
              { id: "call_store", function: { name: "lookup", arguments: huge } },
            ],
          },
        },
      ],
    });
    const actions = await extractObservedActions({
      provider: "openai",
      isSse: false,
      raw,
      storeArgs: true,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]?.argumentsRedacted).toBeDefined();
    expect(actions[0]?.argumentsRedacted?.length).toBe(MAX_ARGUMENTS_REDACTED_CHARS);
    expect(actions[0]?.argumentsRedacted).not.toContain("sk-ant-api03-TEST");
  });
});
