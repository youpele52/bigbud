export type RemoteAgentDownloadKind = "metadata" | "artifact";

export interface RemoteAgentDownloadPolicy {
  readonly kind: RemoteAgentDownloadKind;
  readonly maxAttempts: number;
  readonly attemptTimeoutMs: number;
  readonly overallTimeoutMs: number;
  readonly maxBytes: number;
  readonly baseRetryDelayMs: number;
  readonly maxRetryDelayMs: number;
  readonly maxRedirects: number;
}

export const REMOTE_AGENT_METADATA_DOWNLOAD_POLICY: RemoteAgentDownloadPolicy = {
  kind: "metadata",
  maxAttempts: 3,
  attemptTimeoutMs: 15_000,
  overallTimeoutMs: 50_000,
  maxBytes: 1024 * 1024,
  baseRetryDelayMs: 500,
  maxRetryDelayMs: 10_000,
  maxRedirects: 5,
};

export const REMOTE_AGENT_ARTIFACT_DOWNLOAD_POLICY: RemoteAgentDownloadPolicy = {
  kind: "artifact",
  maxAttempts: 3,
  attemptTimeoutMs: 60_000,
  overallTimeoutMs: 130_000,
  maxBytes: 128 * 1024 * 1024,
  baseRetryDelayMs: 1_000,
  maxRetryDelayMs: 15_000,
  maxRedirects: 5,
};

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export function isRetryableHttpStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

export function safeErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current !== "object") return undefined;
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function safeDirectErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code : undefined;
}

export function safeCauseErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  return safeErrorCode((error as { cause?: unknown }).cause);
}

export function safeErrorName(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current instanceof Error && /^[A-Za-z][A-Za-z0-9.]{0,63}$/.test(current.name)) {
      return current.name;
    }
    if (typeof current !== "object") return undefined;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function isTransientNetworkError(error: unknown): boolean {
  const code = safeErrorCode(error);
  if (code && TRANSIENT_CODES.has(code)) return true;
  if (!(error instanceof TypeError)) return false;
  const message = error.message.toLowerCase();
  return (
    message === "fetch failed" ||
    message.includes("network") ||
    message.includes("socket") ||
    message.includes("connection")
  );
}

export function retryAfterMilliseconds(value: string | null, now: number, maximum: number) {
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - now;
  if (!Number.isFinite(delay) || delay < 0) return undefined;
  return Math.min(delay, maximum);
}

export function retryDelayMilliseconds(
  policy: RemoteAgentDownloadPolicy,
  attempt: number,
  random: () => number,
): number {
  const exponential = Math.min(
    policy.baseRetryDelayMs * 2 ** (attempt - 1),
    policy.maxRetryDelayMs,
  );
  return Math.round(exponential * (0.75 + Math.max(0, Math.min(1, random())) * 0.5));
}
