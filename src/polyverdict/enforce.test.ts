import { describe, expect, it } from "vitest";
import {
  MAX_ENFORCE_ATTEMPTS,
  buildRetryMessagesAnthropic,
  detectSchemaTrigger,
  runEnforceLoop,
} from "./enforce";

const schema = {
  type: "object",
  properties: { n: { type: "number" } },
  required: ["n"],
};

describe("runEnforceLoop", () => {
  it("succeeds on attempt 2 after a failed first completion", async () => {
    const texts = ["not json", '{"n":1}'];
    const seen: number[] = [];
    const result = await runEnforceLoop(
      [{ role: "user", content: "n" }],
      schema,
      async (messages, attempt) => {
        void messages;
        seen.push(attempt);
        return texts[attempt - 1] ?? "";
      },
    );
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.jsonText).toBe('{"n":1}');
    expect(seen).toEqual([1, 2]);
  });

  it("exhausts at MAX_ENFORCE_ATTEMPTS", async () => {
    const result = await runEnforceLoop(
      [{ role: "user", content: "n" }],
      schema,
      async () => "definitely not json",
    );
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(MAX_ENFORCE_ATTEMPTS);
    expect(result.finalText).toBe("definitely not json");
  });
});

describe("buildRetryMessagesAnthropic", () => {
  it("appends assistant text and a user hint as string content", () => {
    const next = buildRetryMessagesAnthropic(
      [{ role: "user", content: "n" }],
      {
        schema,
        errors: ["expected number"],
        assistantText: "nope",
        name: "N",
      },
    );
    expect(next).toHaveLength(3);
    expect(next[1]).toEqual({ role: "assistant", content: "nope" });
    expect(next[2]?.role).toBe("user");
    expect(typeof next[2]?.content).toBe("string");
    expect(String(next[2]?.content)).toContain("expected number");
  });
});

describe("detectSchemaTrigger precedence", () => {
  it("prefers x-axion-schema over body response_format", () => {
    const headerSchema = { type: "string" };
    const bodySchema = { type: "number" };
    const headers = new Headers({
      "x-axion-schema": JSON.stringify(headerSchema),
    });
    const body = {
      response_format: {
        type: "json_schema",
        json_schema: { name: "Body", schema: bodySchema },
      },
    };
    const trigger = detectSchemaTrigger(headers, body);
    expect(trigger?.schema).toEqual(headerSchema);
    expect(trigger?.name).toBeUndefined();
  });
});
