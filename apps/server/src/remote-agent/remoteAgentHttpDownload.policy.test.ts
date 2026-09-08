import { describe, expect, it, vi } from "vitest";

import { downloadRemoteAgentHttp } from "./remoteAgentHttpDownload.ts";
import {
  isTransientNetworkError,
  safeErrorCode,
  type RemoteAgentDownloadPolicy,
} from "./remoteAgentHttpDownload.policy.ts";

const policy: RemoteAgentDownloadPolicy = {
  kind: "metadata",
  maxAttempts: 3,
  attemptTimeoutMs: 100,
  overallTimeoutMs: 1_000,
  maxBytes: 16,
  baseRetryDelayMs: 1,
  maxRetryDelayMs: 2,
  maxRedirects: 1,
};

function failure(code?: string, cause?: unknown): TypeError {
  return Object.assign(new TypeError("fetch failed"), {
    ...(code ? { code } : {}),
    ...(cause ? { cause } : {}),
  });
}

async function requestCountFor(error: unknown): Promise<number> {
  const request = vi.fn(async () => Promise.reject(error));
  await downloadRemoteAgentHttp(
    {
      url: "http://127.0.0.1/source",
      policy,
      urlPolicy: { allowLoopbackHttp: true },
    },
    {
      fetch: request as unknown as typeof fetch,
      logger: () => undefined,
      random: () => 0.5,
      sleep: async () => undefined,
    },
  ).catch(() => undefined);
  return request.mock.calls.length;
}

const permanentCodes = [
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
];

const transientCodes = [
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
];

describe("remote agent HTTP network retry policy", () => {
  it.each(permanentCodes)("treats nested %s as permanent", async (code) => {
    expect(await requestCountFor(failure(undefined, { code }))).toBe(1);
  });

  it.each(transientCodes)("bounds retries for nested %s", async (code) => {
    expect(await requestCountFor(failure(undefined, { code }))).toBe(policy.maxAttempts);
  });

  it("lets a permanent nested code win over a transient wrapper", async () => {
    const error = failure("ECONNRESET", { cause: { code: "CERT_HAS_EXPIRED" } });

    expect(await requestCountFor(error)).toBe(1);
    expect(safeErrorCode(error)).toBe("CERT_HAS_EXPIRED");
  });

  it("retries only the generic top-level code-less fetch failure fallback", async () => {
    expect(await requestCountFor(new TypeError("fetch failed"))).toBe(policy.maxAttempts);
    expect(await requestCountFor(new TypeError("network failed"))).toBe(1);
  });

  it("treats unknown errors as terminal", async () => {
    expect(await requestCountFor(new Error("unknown"))).toBe(1);
    expect(await requestCountFor(failure("UNKNOWN_CODE"))).toBe(1);
  });

  it("honors recognized abort ownership before error codes", () => {
    expect(isTransientNetworkError(failure("CERT_HAS_EXPIRED"), "attempt-timeout")).toBe(true);
    expect(isTransientNetworkError(failure("ECONNRESET"), "caller")).toBe(false);
  });

  it("selects diagnostic codes with bounded, cycle-safe, sanitized traversal", () => {
    const cyclic: { code: string; cause?: unknown } = { code: "unsafe-code" };
    cyclic.cause = cyclic;
    expect(safeErrorCode(cyclic)).toBeUndefined();

    const beyondBound = { code: "CERT_HAS_EXPIRED" };
    let deep: unknown = beyondBound;
    for (let depth = 0; depth < 6; depth += 1) deep = { cause: deep };
    expect(safeErrorCode(deep)).toBeUndefined();

    const throwing = Object.defineProperty({}, "code", {
      get() {
        throw new Error("secret diagnostic value");
      },
    });
    expect(safeErrorCode(throwing)).toBeUndefined();
  });
});
