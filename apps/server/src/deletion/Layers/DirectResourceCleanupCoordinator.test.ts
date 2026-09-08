import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { DirectResourceCleanupRepositoryShape } from "../../persistence/Services/DirectResourceCleanupRepository.ts";
import type { DirectCleanupResource } from "../Services/DirectResourceCleanupExecutor.ts";
import {
  directCleanupRetryDelayMs,
  executeDirectCleanupPlan,
  withDirectCleanupCapacity,
} from "./DirectResourceCleanupCoordinator.ts";
import {
  buildDirectCleanupRequest,
  encodeDirectCleanupRequest,
  serializeDirectCleanupRequest,
} from "./DirectResourceCleanup.request.ts";

const identity = {
  deviceOrVolume: "1",
  inodeOrFileId: "2",
  entryType: "file" as const,
};

function resource(resourceId: string, pageOrdinal: number) {
  return {
    resourceId,
    kind: "attachment",
    root: "/managed",
    relativePath: resourceId,
    quarantineName: `.bigbud-cleanup-${resourceId}`,
    identity,
    rootIdentity: { ...identity, entryType: "directory" as const },
    parentIdentity: { ...identity, entryType: "directory" as const },
    pageOrdinal,
  } satisfies DirectCleanupResource & { readonly pageOrdinal: number };
}

describe("DirectResourceCleanupCoordinator", () => {
  const executorIdentity = {
    buildVersion: "test",
    buildDigest: "test",
    protocolMajor: 1,
    protocolMinor: 2,
  };
  it("preserves persisted page ordinals and attempt generations", async () => {
    const attempts: Array<{ readonly attemptId: string; readonly pageOrdinal: number }> = [];
    const repository = {
      renewLease: () => Effect.succeed(true),
      loadAmbiguousAttempt: () => Effect.sync(() => undefined),
      prepareAttempt: (input: { readonly attemptId: string; readonly pageOrdinal: number }) =>
        Effect.sync(() => attempts.push(input)),
      markAttempt: () => Effect.void,
      recordResults: () => Effect.void,
      complete: () => Effect.void,
    } as unknown as DirectResourceCleanupRepositoryShape;
    const execute = vi.fn(async (input: { resources: ReadonlyArray<DirectCleanupResource> }) =>
      input.resources.map(({ resourceId }) => ({
        resourceId,
        outcome: "removed" as const,
        errorCode: "",
      })),
    );

    await Effect.runPromise(
      executeDirectCleanupPlan({
        operationId: "operation",
        leaseId: "lease",
        attemptCount: 2,
        planDigest: "a".repeat(64),
        proofDigest: "b".repeat(64),
        resources: [resource("first", 1), resource("second", 1)],
        executor: {
          identity: executorIdentity,
          assertAlive: async () => undefined,
          execute,
          close: () => undefined,
          shutdown: async () => undefined,
        },
        repository,
      }),
    );

    expect(attempts).toEqual([
      expect.objectContaining({
        attemptId: expect.stringMatching(/^cleanup:[0-9a-f]{64}$/),
        pageOrdinal: 1,
      }),
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ requestId: attempts[0]!.attemptId }),
      }),
    );
  });

  it("uses capped deterministic exponential retry delays", () => {
    expect(directCleanupRetryDelayMs(0, () => 0)).toBe(1_000);
    expect(directCleanupRetryDelayMs(2, () => 0.5)).toBe(4_400);
    expect(directCleanupRetryDelayMs(20, () => 1)).toBe(60_000);
  });

  it("shares one bounded execution permit across immediate and recovery callers", async () => {
    let active = 0;
    let maximum = 0;
    const runs = Array.from({ length: 8 }, () =>
      Effect.runPromise(
        withDirectCleanupCapacity(
          Effect.tryPromise(async () => {
            active += 1;
            maximum = Math.max(maximum, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active -= 1;
          }),
        ),
      ),
    );
    await Promise.all(runs);
    expect(maximum).toBe(1);
  });

  it("keeps a sent page ambiguous after a process crash so recovery replays it byte-for-byte", async () => {
    const attemptStates: string[] = [];
    const retries: boolean[] = [];
    const repository = {
      renewLease: () => Effect.succeed(true),
      loadAmbiguousAttempt: () => Effect.sync(() => undefined),
      prepareAttempt: () => Effect.void,
      markAttempt: (_id: string, state: string) => Effect.sync(() => attemptStates.push(state)),
      scheduleRetry: (
        _operation: string,
        _lease: string,
        _code: string,
        _at: string,
        increment: boolean,
      ) => Effect.sync(() => retries.push(increment)),
    } as unknown as DirectResourceCleanupRepositoryShape;

    const completed = await Effect.runPromise(
      executeDirectCleanupPlan({
        operationId: "operation",
        leaseId: "lease",
        attemptCount: 3,
        planDigest: "a".repeat(64),
        proofDigest: "b".repeat(64),
        resources: [resource("only", 0)],
        executor: {
          identity: executorIdentity,
          assertAlive: async () => undefined,
          execute: async () => Promise.reject(new Error("child exited after acceptance")),
          close: () => undefined,
          shutdown: async () => undefined,
        },
        repository,
      }),
    );

    expect(completed).toBe(false);
    expect(attemptStates).toEqual(["sent", "ambiguous"]);
    expect(retries).toEqual([true]);
  });

  it("replays the persisted ambiguous deadline and encoded request without regeneration", async () => {
    const page = [resource("only", 0)];
    const request = buildDirectCleanupRequest({
      requestId: `cleanup:${"1".repeat(64)}`,
      operationId: "operation",
      planDigest: "a".repeat(64),
      proofDigest: "b".repeat(64),
      deadlineUnixMs: 1_800_000_000_000,
      platform: process.platform === "darwin" ? "macos" : process.platform,
      resources: page,
    });
    const encoded = encodeDirectCleanupRequest(request);
    const execute = vi.fn(async () => [
      { resourceId: "only", outcome: "deadline_exceeded" as const, errorCode: "DEADLINE" },
    ]);
    const repository = {
      renewLease: () => Effect.succeed(true),
      loadAmbiguousAttempt: () =>
        Effect.succeed({
          attemptId: request.requestId,
          pageDigest: Buffer.from(request.pageDigest).toString("hex"),
          resourceIds: ["only"],
          requestJson: serializeDirectCleanupRequest(request),
          requestFrameHex: Buffer.from(encoded).toString("hex"),
          deadlineUnixMs: request.deadlineUnixMs,
        }),
      markAttempt: () => Effect.void,
      recordResults: () => Effect.void,
      scheduleRetry: () => Effect.void,
      prepareAttempt: vi.fn(() => Effect.void),
    } as unknown as DirectResourceCleanupRepositoryShape;

    await Effect.runPromise(
      executeDirectCleanupPlan({
        operationId: "operation",
        leaseId: "lease",
        attemptCount: 4,
        planDigest: "a".repeat(64),
        proofDigest: "b".repeat(64),
        resources: page,
        executor: {
          identity: executorIdentity,
          assertAlive: async () => undefined,
          execute,
          close: () => undefined,
          shutdown: async () => undefined,
        },
        repository,
      }),
    );

    expect(repository.prepareAttempt).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ deadlineUnixMs: request.deadlineUnixMs }),
        encodedRequest: encoded,
      }),
    );
  });

  it("schedules after repository atomically records the known retry generation", async () => {
    const retries: Array<{ readonly errorCode: string; readonly nextAttemptAt: string }> = [];
    const repository = {
      renewLease: () => Effect.succeed(true),
      loadAmbiguousAttempt: () => Effect.sync(() => undefined),
      prepareAttempt: () => Effect.void,
      markAttempt: () => Effect.void,
      recordResults: (
        _operation: string,
        _lease: string,
        _attempt: string,
        _results: unknown,
        _at: string,
        retry: { readonly errorCode: string; readonly nextAttemptAt: string },
      ) => Effect.sync(() => retries.push(retry)),
    } as unknown as DirectResourceCleanupRepositoryShape;

    await Effect.runPromise(
      executeDirectCleanupPlan({
        operationId: "operation",
        leaseId: "lease",
        attemptCount: 3,
        planDigest: "a".repeat(64),
        proofDigest: "b".repeat(64),
        resources: [resource("only", 0)],
        executor: {
          identity: executorIdentity,
          assertAlive: async () => undefined,
          execute: async () => [{ resourceId: "only", outcome: "busy", errorCode: "BUSY" }],
          close: () => undefined,
          shutdown: async () => undefined,
        },
        repository,
      }),
    );

    expect(retries).toEqual([expect.objectContaining({ errorCode: "resource_retryable" })]);
  });

  it("blocks cleanup after the persisted retry budget is exhausted", async () => {
    const blocked: string[] = [];
    const repository = {
      renewLease: () => Effect.succeed(true),
      loadAmbiguousAttempt: () => Effect.sync(() => undefined),
      prepareAttempt: () => Effect.void,
      markAttempt: () => Effect.void,
      scheduleRetry: () => Effect.void,
      block: (_operation: string, errorCode: string) => Effect.sync(() => blocked.push(errorCode)),
    } as unknown as DirectResourceCleanupRepositoryShape;

    await Effect.runPromise(
      executeDirectCleanupPlan({
        operationId: "operation",
        leaseId: "lease",
        attemptCount: 7,
        planDigest: "a".repeat(64),
        proofDigest: "b".repeat(64),
        resources: [resource("only", 0)],
        executor: {
          identity: executorIdentity,
          assertAlive: async () => undefined,
          execute: async () => Promise.reject(new Error("child exited after acceptance")),
          close: () => undefined,
          shutdown: async () => undefined,
        },
        repository,
      }),
    );

    expect(blocked).toEqual(["retry_budget_exhausted"]);
  });
});
