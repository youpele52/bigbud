import { expect, it, vi } from "vitest";

const logged = vi.hoisted(() => [] as Array<{ message: string; details: object }>);
vi.mock("./Runtime.settlement.log.ts", () => ({
  logV2SettlementDiagnostic: (message: string, details: object) =>
    logged.push({ message, details }),
}));

const { classifyV2RequestFailure, logV2RequestFailure } = await import("./Client.diagnostics.ts");

const none = { consentAborted: false, operationAborted: false, callerAborted: false };

it("keeps bigbud-authored guard and deadline text but never native error text", () => {
  expect(
    classifyV2RequestFailure("op", new Error("V2 shared request authority missing/mismatched.")),
  ).toEqual({
    kind: "guard",
    reason: "V2 shared request authority missing/mismatched.",
    errorName: "Error",
  });
  expect(classifyV2RequestFailure("op", new Error("op timed out after 10000ms."))).toEqual({
    kind: "timeout",
    reason: "timed out after 10000ms.",
    errorName: "Error",
  });
  expect(classifyV2RequestFailure("op", new TypeError("fetch failed: secret-token"))).toEqual({
    kind: "native",
    errorName: "TypeError",
  });
  class RenamedError extends Error {
    override name = "leaked: secret-token";
  }
  expect(classifyV2RequestFailure("op", new RenamedError("secret"))).toEqual({
    kind: "native",
    errorName: "Error",
  });
  expect(classifyV2RequestFailure("op", new DOMException("aborted", "AbortError")).kind).toBe(
    "cancelled",
  );
});

it("logs fence aborts but skips cancellations the caller requested itself", () => {
  logged.length = 0;
  const abort = new DOMException("aborted", "AbortError");
  logV2RequestFailure("op", abort, { ...none, callerAborted: true });
  expect(logged).toHaveLength(0);
  logV2RequestFailure("op", abort, { ...none, consentAborted: true });
  expect(logged).toEqual([
    {
      message: "OpenCode v2 request failed",
      details: {
        operation: "op",
        kind: "cancelled",
        errorName: "AbortError",
        ...none,
        consentAborted: true,
      },
    },
  ]);
});
