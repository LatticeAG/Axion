/**
 * Prefix-anchored secret regex. This is not PII completeness.
 * Run on rawText and each belief / evidence / actionTaken before persist.
 * Never log the matched secret.
 */

export type RedactionKind =
  | "pem"
  | "github_pat"
  | "github"
  | "anthropic_key"
  | "openai_key"
  | "bearer"
  | "aws_access_key"
  | "slack";

export interface RedactionResult {
  text: string;
  hits: number;
}

const PEM_BLOCK =
  /-----BEGIN ([A-Z ]+)-----[\s\S]*?-----END \1-----/g;
const GITHUB_PAT = /(^|[^A-Za-z0-9])(github_pat_[A-Za-z0-9_]+)/g;
const GITHUB_CLASSIC = /(^|[^A-Za-z0-9])(ghp_[A-Za-z0-9_]+)/g;
const ANTHROPIC_KEY = /(^|[^A-Za-z0-9])(sk-ant-[A-Za-z0-9_-]+)/g;
const OPENAI_KEY = /(^|[^A-Za-z0-9])(sk-[A-Za-z0-9_-]+)/g;
const BEARER = /Bearer [A-Za-z0-9._\-]+/g;
const AWS_ACCESS_KEY = /AKIA[0-9A-Z]{16}/g;
const SLACK = /(^|[^A-Za-z0-9])(xox[baprs]-[A-Za-z0-9-]+)/g;

/** Replace known secret shapes with [REDACTED:<kind>] and count hits. */
export function redactSecrets(text: string): RedactionResult {
  if (!text) return { text, hits: 0 };
  let hits = 0;
  let next = text;

  next = next.replace(PEM_BLOCK, () => {
    hits += 1;
    return marker("pem");
  });
  next = replacePrefixed(next, GITHUB_PAT, "github_pat", () => {
    hits += 1;
  });
  next = replacePrefixed(next, GITHUB_CLASSIC, "github", () => {
    hits += 1;
  });
  next = replacePrefixed(next, ANTHROPIC_KEY, "anthropic_key", () => {
    hits += 1;
  });
  next = replacePrefixed(next, OPENAI_KEY, "openai_key", () => {
    hits += 1;
  });
  next = next.replace(BEARER, () => {
    hits += 1;
    return marker("bearer");
  });
  next = next.replace(AWS_ACCESS_KEY, () => {
    hits += 1;
    return marker("aws_access_key");
  });
  next = replacePrefixed(next, SLACK, "slack", () => {
    hits += 1;
  });

  return { text: next, hits };
}

function marker(kind: RedactionKind): string {
  return `[REDACTED:${kind}]`;
}

function replacePrefixed(
  text: string,
  pattern: RegExp,
  kind: RedactionKind,
  onHit: () => void,
): string {
  return text.replace(pattern, (_all, prefix: string) => {
    onHit();
    return `${prefix}${marker(kind)}`;
  });
}
