import { describe, expect, it } from "vitest";
import { redactSecrets } from "./secrets";

describe("redactSecrets", () => {
  it("redacts a PEM block as one hit", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIBOgIBAAJBAK8=",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const out = redactSecrets(`keep ${pem} after`);
    expect(out.hits).toBe(1);
    expect(out.text).toBe("keep [REDACTED:pem] after");
  });

  it("redacts Anthropic, OpenAI, GitHub, Bearer, AWS, and Slack prefixes", () => {
    const out = redactSecrets(
      [
        "sk-ant-api03-TEST",
        "sk-proj-ABCDEF",
        "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        "github_pat_11AAAA_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "Bearer eyJhbGciOiJIUzI1NiJ9.aaa.bbb",
        "AKIAIOSFODNN7EXAMPLE",
        "xoxb-1234-abcdEFGH",
      ].join(" "),
    );
    expect(out.hits).toBe(7);
    expect(out.text).not.toContain("sk-ant-api03-TEST");
    expect(out.text).not.toContain("sk-proj-ABCDEF");
    expect(out.text).not.toContain("ghp_");
    expect(out.text).not.toContain("github_pat_");
    expect(out.text).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(out.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out.text).not.toContain("xoxb-1234");
    expect(out.text).toContain("[REDACTED:anthropic_key]");
    expect(out.text).toContain("[REDACTED:openai_key]");
    expect(out.text).toContain("[REDACTED:github]");
    expect(out.text).toContain("[REDACTED:github_pat]");
    expect(out.text).toContain("[REDACTED:bearer]");
    expect(out.text).toContain("[REDACTED:aws_access_key]");
    expect(out.text).toContain("[REDACTED:slack]");
  });

  it("does not classify Anthropic keys as OpenAI keys", () => {
    const out = redactSecrets("sk-ant-api03-TEST");
    expect(out.hits).toBe(1);
    expect(out.text).toBe("[REDACTED:anthropic_key]");
    expect(out.text).not.toContain("openai_key");
  });

  it("does not redact ordinary prose about tokens and cache misses", () => {
    const prose = "The token expired because the cache missed.";
    expect(redactSecrets(prose)).toEqual({ text: prose, hits: 0 });
  });

  it("does not treat 'may' as a secret", () => {
    const prose = "The deploy may fail if the cache missed.";
    expect(redactSecrets(prose).hits).toBe(0);
  });
});
