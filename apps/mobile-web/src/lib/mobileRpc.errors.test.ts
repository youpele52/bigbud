import * as Cause from "effect/Cause";
import { describe, expect, it } from "vitest";
import { MobileRecoveryUnsupportedError, normalizeRecoveryRpcError } from "./mobileRpc.errors";

const method = "mobile.recovery.getBaseline";
describe("typed old-server recovery evidence", () => {
  it("accepts the exact single RPC Die for the requested method", () => {
    expect(
      normalizeRecoveryRpcError(Cause.die(`Unknown request tag: ${method}`), method),
    ).toBeInstanceOf(MobileRecoveryUnsupportedError);
  });
  it.each([
    new Error(`Unknown request tag: ${method}`),
    Cause.fail(`Unknown request tag: ${method}`),
    Cause.die("Unknown request tag: mobile.recovery.subscribe"),
    Cause.die(`Unauthorized: Unknown request tag: ${method}`),
    Cause.die("Timed out waiting for mobile recovery"),
    Cause.die("Transport closed"),
    Cause.combine(Cause.die(`Unknown request tag: ${method}`), Cause.fail("unauthorized")),
    { reasons: [{ _tag: "Die", defect: `Unknown request tag: ${method}` }] },
  ])("rejects generic, mixed, wrong-method, and untyped evidence: %s", (error) => {
    expect(normalizeRecoveryRpcError(error, method)).toBe(error);
  });
});
