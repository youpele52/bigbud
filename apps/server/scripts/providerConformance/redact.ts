/**
 * Redaction for the provider conformance report (WP-5D). Applied to every string that reaches
 * the JSON or markdown output, on top of the structural rule that results never copy
 * `executablePath`, provider `message`, model output or anything but the fixed test prompts.
 *
 * Removed: absolute and home-relative paths, bearer/basic credentials, API-key and token
 * shapes (OpenAI/Anthropic `sk-`, GitHub `gh?_`/`github_pat_`, Slack `xox?-`, AWS `AKIA`,
 * Google `AIza`), JWTs, long hex/base64 runs, `key=value` pairs with secret-like keys, email
 * addresses, URL credentials and the run's own nonces.
 */
const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/giu, "<redacted-credential>"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/gu, "<redacted-token>"],
  [
    /\b(?:sk-(?:ant-|proj-)?|gh[pousr]_|github_pat_|xox[abposr]-|AKIA|AIza)[A-Za-z0-9_-]{8,}/gu,
    "<redacted-token>",
  ],
  [
    /\b([A-Za-z_]*(?:secret|token|password|passwd|api[_-]?key|auth|cookie|session)[A-Za-z_]*)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;]+)/giu,
    "$1=<redacted>",
  ],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/giu, "<scheme>://<redacted>@"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu, "<email>"],
  [/\bBBCONF-[0-9A-F]{8}\b/gu, "<nonce>"],
  [/\b[0-9a-f]{32,}\b/giu, "<redacted-hex>"],
  [/\b[A-Za-z0-9+/]{40,}={0,2}/gu, "<redacted-base64>"],
  [/(?:~|\$HOME)(?:\/[^\s'"`:;,)]+)+/gu, "<path>"],
  [/\b[A-Za-z]:\\(?:[^\s'"`\\]+\\?)+/gu, "<path>"],
  [/(?<![A-Za-z0-9.<>-])\/(?:[^\s'"`:;,)/]+\/?)+/gu, "<path>"],
];

const MAX_LENGTH = 300;

export function redactText(value: string): string {
  let next = value;
  for (const [pattern, replacement] of RULES) next = next.replace(pattern, replacement);
  return next.length > MAX_LENGTH ? `${next.slice(0, MAX_LENGTH)}…` : next;
}

/** Deep copy with every string redacted. Keys are kept; they are harness-defined. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map((entry) => redactDeep(entry)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactDeep(entry)]),
    ) as T;
  return value;
}
