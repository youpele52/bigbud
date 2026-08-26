import { describe, expect, it } from "vitest";

import { classifyTerminalRuntimeLeaseError } from "./Manager.leaseError.ts";

describe("classifyTerminalRuntimeLeaseError", () => {
  it("classifies structured storage exhaustion before misleading fallback text", () => {
    expect(
      classifyTerminalRuntimeLeaseError({
        message: "database is locked",
        reason: { _tag: "UnknownError", cause: { code: "SQLITE_FULL" } },
      }),
    ).toBe("storageFull");
  });

  it("classifies Effect SQL lock timeout reasons as database busy", () => {
    expect(
      classifyTerminalRuntimeLeaseError({
        _tag: "SqlError",
        reason: { _tag: "LockTimeoutError", cause: new Error("internal") },
      }),
    ).toBe("databaseBusy");
  });

  it("classifies extended SQLite constraint codes as conflicts", () => {
    expect(classifyTerminalRuntimeLeaseError({ code: "SQLITE_CONSTRAINT_UNIQUE" })).toBe(
      "conflict",
    );
  });

  it("returns unknown for cyclic unclassified causes", () => {
    const cause: { message: string; cause?: unknown } = { message: "statement failed" };
    cause.cause = cause;
    expect(classifyTerminalRuntimeLeaseError(cause)).toBe("unknown");
  });

  it("uses bounded message fallback for wrapped SQLite failures", () => {
    expect(
      classifyTerminalRuntimeLeaseError({
        cause: { message: "write failed: no space left on device" },
      }),
    ).toBe("storageFull");
  });
});
