export type RemoteAgentDownloadKind = "metadata" | "artifact";
export type RemoteAgentDownloadAbortOwner =
  | "caller"
  | "shutdown"
  | "attempt-timeout"
  | "overall-timeout";

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
const PERMANENT_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_UNTRUSTED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED",
  "ENOTFOUND",
  "ERR_INVALID_URL",
  "UND_ERR_INVALID_ARG",
  "UND_ERR_NOT_SUPPORTED",
  "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH",
  "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
  "UND_ERR_ABORTED",
]);
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_DESTROYED",
  "UND_ERR_CLOSED",
]);
const ERROR_CHAIN_DEPTH = 6;
const SAFE_CODE = /^[A-Z0-9_]{1,64}$/;

function safeProperty(value: object, property: "cause" | "code"): unknown {
  try {
    return (value as Record<string, unknown>)[property];
  } catch {
    return undefined;
  }
}

function errorChain(error: unknown): readonly object[] {
  const chain: object[] = [];
  const visited = new Set<object>();
  let current = error;
  for (let depth = 0; depth < ERROR_CHAIN_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null || visited.has(current)) break;
    visited.add(current);
    chain.push(current);
    current = safeProperty(current, "cause");
  }
  return chain;
}

function codeFrom(value: object): string | undefined {
  const code = safeProperty(value, "code");
  return typeof code === "string" && SAFE_CODE.test(code) ? code : undefined;
}

function errorCodes(error: unknown): readonly string[] {
  return errorChain(error).flatMap((value) => {
    const code = codeFrom(value);
    return code ? [code] : [];
  });
}

export function isRetryableHttpStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

export function safeErrorCode(error: unknown): string | undefined {
  const codes = errorCodes(error);
  return (
    codes.find((code) => PERMANENT_CODES.has(code)) ??
    codes.find((code) => TRANSIENT_CODES.has(code)) ??
    codes[0]
  );
}

export function safeDirectErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  return codeFrom(error);
}

export function safeCauseErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  return safeErrorCode(safeProperty(error, "cause"));
}

export function safeErrorName(error: unknown): string | undefined {
  for (const current of errorChain(error)) {
    if (current instanceof Error && /^[A-Za-z][A-Za-z0-9.]{0,63}$/.test(current.name)) {
      return current.name;
    }
  }
  return undefined;
}

export function isTransientNetworkError(
  error: unknown,
  abortOwner?: RemoteAgentDownloadAbortOwner,
): boolean {
  if (abortOwner) return abortOwner === "attempt-timeout";
  const codes = errorCodes(error);
  if (codes.some((code) => PERMANENT_CODES.has(code))) return false;
  if (codes.some((code) => TRANSIENT_CODES.has(code))) return true;
  return safeDirectErrorCode(error) === undefined && error instanceof TypeError
    ? error.message === "fetch failed"
    : false;
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
