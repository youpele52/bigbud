import { Cause } from "effect";
import { describe, expect, it } from "vitest";

import { DirectResourceCleanupExecutorError } from "../Services/DirectResourceCleanupExecutor.ts";
import {
  ThreadDeletionOperationError,
  toThreadDeletionOperationError,
} from "../Services/ThreadDeletion.ts";
import {
  DELETION_FAILURE_DETAIL_MAX_LENGTH,
  describeDeletionFailure,
} from "./DeletionFailure.detail.ts";

describe("describeDeletionFailure", () => {
  it("keeps a nested tagged error's reason and drops tags and stack frames", () => {
    const executorError = new DirectResourceCleanupExecutorError({
      detail: "Resource cleanup is unsupported on linux/ia32.",
    });
    const wrapped = new ThreadDeletionOperationError({ detail: String(executorError) });

    expect(describeDeletionFailure(Cause.fail(wrapped))).toBe(
      "Resource cleanup is unsupported on linux/ia32.",
    );
    expect(
      describeDeletionFailure(Cause.die(new Error("agent exited\n    at /private/path.mjs:1:1"))),
    ).toBe("agent exited");
  });

  it("reports a structured error's root cause, as for the live linux/arm64 plan insert", () => {
    const constraint = "CHECK constraint failed: expected_platform IN ('linux/x64')";
    const sqlError = Object.assign(new Error('effect/sql/SqlError({"reason":…})'), {
      _tag: "SqlError",
      cause: { _tag: "UnknownError", cause: new Error(constraint) },
    });
    const wrapped = toThreadDeletionOperationError(sqlError);

    expect(wrapped.detail).toBe(constraint);
    expect(wrapped.cause).toBe(sqlError);
    expect(toThreadDeletionOperationError(wrapped)).toBe(wrapped);
    expect(describeDeletionFailure(Cause.fail(wrapped))).toBe(constraint);
  });

  it("never records an empty reason and bounds long ones", () => {
    expect(
      describeDeletionFailure(Cause.fail(new ThreadDeletionOperationError({ detail: "" }))),
    ).toBe("ThreadDeletionOperationError");
    expect(describeDeletionFailure(Cause.empty)).toBe(
      "Thread deletion failed for an unknown reason.",
    );
    const long = describeDeletionFailure(Cause.fail("x".repeat(5_000)));
    expect(long).toHaveLength(DELETION_FAILURE_DETAIL_MAX_LENGTH);
  });
});
