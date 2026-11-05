import { describe, expect, it } from "vitest";
import {
  isMuseCreationAlreadyApplied,
  isProvenNativeRefusal,
  mapMuseRequestError,
  mapMuseValidationError,
  museValidationError,
  getMuseFailureEvidence,
} from "./Client.errors.ts";

describe("Muse typed failure boundaries", () => {
  it.each([
    new Error("broken"),
    "broken",
    undefined,
    null,
    42,
    { detail: "db conflict" },
    { message: "", detail: "useful detail" },
  ])("retains original evidence privately: %s", (cause) => {
    const error = mapMuseRequestError("turn/start", cause, "unsafe-to-replay");
    expect(error._tag).toBe("ProviderAdapterRequestError");
    expect(getMuseFailureEvidence(error)).toBe(cause);
    expect(error.cause).toBeUndefined();
    expect(error.failureClass).toBe("unsafe-to-replay");
    expect(error.detail.length).toBeLessThanOrEqual(300);
  });
  it("redacts secrets and account labels, normalizes whitespace before bounding", () => {
    const error = mapMuseRequestError("read", {
      message:
        "Bearer abc123\ntoken=topsecret user@example.test https://host.test/auth " +
        "x".repeat(400),
    });
    expect(error.detail).not.toMatch(/abc123|topsecret|user@example|host.test|\n/);
    expect(error.detail).toHaveLength(300);
    expect(mapMuseRequestError("write", { message: "", detail: "write conflict" }).detail).toBe(
      "write conflict",
    );
  });
  it("narrows known input errors, maps unexpected throws and classifies raw native evidence only", () => {
    const known = museValidationError("input", "bad", "invalid-request");
    expect(mapMuseValidationError("input", known)).toBe(known);
    expect(mapMuseValidationError("input", "bad")._tag).toBe("ProviderAdapterRequestError");
    for (const kind of ["timeout", "overloaded", "backpressure", "transportClosed"])
      expect(isProvenNativeRefusal({ kind })).toBe(false);
    expect(isProvenNativeRefusal({ kind: "commandRejected" })).toBe(true);
    expect(
      isMuseCreationAlreadyApplied({
        kind: "commandRejected",
        data: { reason: "session_id_conflict" },
      }),
    ).toBe(true);
    expect(isMuseCreationAlreadyApplied(new Error("session_id_conflict"))).toBe(false);
  });
  it("classifies private native evidence without trusting a public cause on unrelated errors", () => {
    const native = Object.assign(new Error("commandId payload conflict"), {
      kind: "commandRejected",
    });
    const wrapped = mapMuseRequestError("session/start", native, "unsafe-to-replay");
    expect(isProvenNativeRefusal(getMuseFailureEvidence(wrapped))).toBe(true);
    expect(isMuseCreationAlreadyApplied(getMuseFailureEvidence(wrapped))).toBe(true);
    expect(getMuseFailureEvidence(new Error("unrelated", { cause: native }))).toBeUndefined();
    expect(getMuseFailureEvidence(null)).toBeUndefined();
    expect(getMuseFailureEvidence("unrelated")).toBeUndefined();
  });
});
