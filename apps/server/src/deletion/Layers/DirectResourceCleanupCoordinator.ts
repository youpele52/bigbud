import { Data, Effect } from "effect";

import {
  assertDirectCleanupFrameMatches,
  buildDirectCleanupRequest,
  deserializeDirectCleanupRequest,
  directCleanupAttemptId,
  encodeDirectCleanupRequest,
  serializeDirectCleanupRequest,
} from "./DirectResourceCleanup.request.ts";
import type {
  DirectCleanupResource,
  PreparedDirectResourceCleanupExecutor,
} from "../Services/DirectResourceCleanupExecutor.ts";
import type { DirectResourceCleanupRepositoryShape } from "../../persistence/Services/DirectResourceCleanupRepository.ts";

const retryableOutcomes = new Set([
  "busy",
  "permission_denied",
  "deadline_exceeded",
  "io_failure",
  "process_failure",
  "protocol_failure",
]);

const MAX_QUEUED_EXECUTIONS = 64;
export const MAX_DIRECT_CLEANUP_EXECUTION_ATTEMPTS = 8;

class DirectResourceCleanupCoordinatorError extends Data.TaggedError(
  "DirectResourceCleanupCoordinatorError",
)<{ readonly detail: string; readonly cause?: unknown }> {}

class CleanupExecutionGate {
  private active = false;
  private readonly queue: Array<{
    readonly resolve: (release: () => void) => void;
    readonly reject: (error: Error) => void;
    readonly signal: AbortSignal;
    readonly abort: () => void;
  }> = [];

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new Error("cleanup execution was cancelled"));
    if (!this.active) {
      this.active = true;
      return Promise.resolve(() => this.release());
    }
    if (this.queue.length >= MAX_QUEUED_EXECUTIONS) {
      return Promise.reject(new Error("cleanup execution queue is full"));
    }
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        signal,
        abort: () => {
          const index = this.queue.indexOf(entry);
          if (index >= 0) this.queue.splice(index, 1);
          reject(new Error("cleanup execution was cancelled"));
        },
      };
      signal.addEventListener("abort", entry.abort, { once: true });
      this.queue.push(entry);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (!next) {
      this.active = false;
      return;
    }
    next.signal.removeEventListener("abort", next.abort);
    next.resolve(() => this.release());
  }
}

const executionGate = new CleanupExecutionGate();

export function withDirectCleanupCapacity<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.tryPromise({
    try: (signal) => executionGate.acquire(signal),
    catch: (error) =>
      new DirectResourceCleanupCoordinatorError({ detail: String(error), cause: error }),
  }).pipe(Effect.flatMap((release) => effect.pipe(Effect.ensuring(Effect.sync(release)))));
}

export function directCleanupRetryDelayMs(
  attemptCount: number,
  random: () => number = Math.random,
): number {
  const base = Math.min(60_000, 1_000 * 2 ** Math.min(Math.max(0, attemptCount), 6));
  return Math.min(60_000, base + Math.floor(base * 0.2 * Math.max(0, Math.min(1, random()))));
}

export const executeDirectCleanupPlan = Effect.fn("DirectResourceCleanupCoordinator.execute")(
  function* (input: {
    readonly operationId: string;
    readonly leaseId: string;
    readonly attemptCount: number;
    readonly planDigest: string;
    readonly proofDigest: string;
    readonly resources: ReadonlyArray<DirectCleanupResource & { readonly pageOrdinal?: number }>;
    readonly executor: PreparedDirectResourceCleanupExecutor;
    readonly repository: DirectResourceCleanupRepositoryShape;
  }) {
    if (input.attemptCount >= MAX_DIRECT_CLEANUP_EXECUTION_ATTEMPTS) {
      yield* input.repository.block(
        input.operationId,
        "retry_budget_exhausted",
        new Date().toISOString(),
      );
      return false;
    }
    const rustIdentity = input.executor.identity ?? {
      buildVersion: "unknown",
      buildDigest: "unknown",
      protocolMajor: 0,
      protocolMinor: 0,
    };
    const pages = new Map<
      number,
      Array<DirectCleanupResource & { readonly pageOrdinal?: number }>
    >();
    input.resources.forEach((resource, index) => {
      const pageOrdinal = resource.pageOrdinal ?? Math.floor(index / 256);
      const page = pages.get(pageOrdinal);
      if (page) page.push(resource);
      else pages.set(pageOrdinal, [resource]);
    });
    for (const [pageOrdinal, page] of pages) {
      const renewedAt = new Date().toISOString();
      const renewed = yield* input.repository.renewLease({
        operationId: input.operationId,
        leaseId: input.leaseId,
        renewedAt,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      if (!renewed) return yield* Effect.fail(new Error("cleanup lease expired"));
      const resourceIds = page.map((resource) => resource.resourceId);
      const ambiguous = yield* input.repository.loadAmbiguousAttempt(
        input.operationId,
        pageOrdinal,
      );
      let request;
      let encodedRequest: Uint8Array;
      let attemptId: string;
      if (ambiguous) {
        request = deserializeDirectCleanupRequest(ambiguous.requestJson);
        encodedRequest = assertDirectCleanupFrameMatches(request, ambiguous.requestFrameHex);
        attemptId = ambiguous.attemptId;
        if (
          JSON.stringify(ambiguous.resourceIds) !== JSON.stringify(resourceIds) ||
          request.operationId !== input.operationId ||
          Buffer.from(request.planDigest).toString("hex") !== input.planDigest ||
          Buffer.from(request.finalizeProofDigest).toString("hex") !== input.proofDigest ||
          Buffer.from(request.pageDigest).toString("hex") !== ambiguous.pageDigest
        ) {
          return yield* Effect.fail(new Error("ambiguous cleanup attempt conflicts with plan"));
        }
      } else {
        request = buildDirectCleanupRequest({
          requestId: "",
          operationId: input.operationId,
          planDigest: input.planDigest,
          proofDigest: input.proofDigest,
          deadlineUnixMs: Date.now() + 30_000,
          platform:
            process.platform === "darwin"
              ? "macos"
              : process.platform === "win32"
                ? "windows"
                : process.platform,
          resources: page,
        });
        attemptId = directCleanupAttemptId({
          operationId: input.operationId,
          pageOrdinal,
          attemptCount: input.attemptCount,
          pageDigest: Buffer.from(request.pageDigest).toString("hex"),
        });
        request = buildDirectCleanupRequest({
          requestId: attemptId,
          operationId: input.operationId,
          planDigest: input.planDigest,
          proofDigest: input.proofDigest,
          deadlineUnixMs: request.deadlineUnixMs,
          platform: request.platform,
          resources: page,
        });
        encodedRequest = encodeDirectCleanupRequest(request);
        yield* input.repository.prepareAttempt({
          attemptId,
          operationId: input.operationId,
          pageOrdinal,
          pageDigest: Buffer.from(request.pageDigest).toString("hex"),
          resourceIds,
          requestJson: serializeDirectCleanupRequest(request),
          requestFrameHex: Buffer.from(encodedRequest).toString("hex"),
          deadlineUnixMs: request.deadlineUnixMs,
          leaseId: input.leaseId,
          at: new Date().toISOString(),
        });
      }
      yield* input.repository.markAttempt(
        attemptId,
        "sent",
        new Date().toISOString(),
        input.leaseId,
      );
      const startedAt = Date.now();
      const execution = yield* Effect.exit(
        Effect.tryPromise({
          try: (signal) =>
            input.executor.execute({
              request,
              encodedRequest,
              resources: page,
              signal,
            }),
          catch: (error) =>
            new DirectResourceCleanupCoordinatorError({ detail: String(error), cause: error }),
        }),
      );
      if (execution._tag === "Failure") {
        yield* Effect.logWarning("direct resource cleanup page deferred", {
          operationId: input.operationId,
          pageOrdinal,
          attempt: input.attemptCount,
          durationMs: Date.now() - startedAt,
          code: "process_failure",
          entityKind: page[0]?.kind.startsWith("project-") ? "project" : "thread",
          resourceKinds: [...new Set(page.map((resource) => resource.kind))],
          rustBuildVersion: rustIdentity.buildVersion,
          rustBuildDigest: rustIdentity.buildDigest,
          protocolMajor: rustIdentity.protocolMajor,
          protocolMinor: rustIdentity.protocolMinor,
        });
        yield* input.repository.markAttempt(
          attemptId,
          "ambiguous",
          new Date().toISOString(),
          input.leaseId,
        );
        yield* input.repository.scheduleRetry(
          input.operationId,
          input.leaseId,
          "process_failure",
          new Date(Date.now() + directCleanupRetryDelayMs(input.attemptCount)).toISOString(),
          true,
        );
        if (input.attemptCount + 1 >= MAX_DIRECT_CLEANUP_EXECUTION_ATTEMPTS) {
          yield* input.repository.block(
            input.operationId,
            "retry_budget_exhausted",
            new Date().toISOString(),
          );
        }
        return false;
      }
      const hasRetryable = execution.value.some((result) => retryableOutcomes.has(result.outcome));
      const retryBudgetExhausted =
        hasRetryable && input.attemptCount + 1 >= MAX_DIRECT_CLEANUP_EXECUTION_ATTEMPTS;
      yield* input.repository.recordResults(
        input.operationId,
        input.leaseId,
        attemptId,
        execution.value,
        new Date().toISOString(),
        hasRetryable && !retryBudgetExhausted
          ? {
              errorCode: "resource_retryable",
              nextAttemptAt: new Date(
                Date.now() + directCleanupRetryDelayMs(input.attemptCount),
              ).toISOString(),
            }
          : undefined,
      );
      if (retryBudgetExhausted) {
        yield* input.repository.block(
          input.operationId,
          "retry_budget_exhausted",
          new Date().toISOString(),
        );
      }
      yield* Effect.logInfo("direct resource cleanup page completed", {
        operationId: input.operationId,
        pageOrdinal,
        attempt: input.attemptCount,
        durationMs: Date.now() - startedAt,
        resultCount: execution.value.length,
        outcomes: Object.fromEntries(
          execution.value.reduce(
            (counts, result) => counts.set(result.outcome, (counts.get(result.outcome) ?? 0) + 1),
            new Map<string, number>(),
          ),
        ),
        entityKind: page[0]?.kind.startsWith("project-") ? "project" : "thread",
        resourceKinds: [...new Set(page.map((resource) => resource.kind))],
        rustBuildVersion: rustIdentity.buildVersion,
        rustBuildDigest: rustIdentity.buildDigest,
        protocolMajor: rustIdentity.protocolMajor,
        protocolMinor: rustIdentity.protocolMinor,
      });
      if (hasRetryable) return false;
    }
    yield* input.repository.complete(input.operationId, new Date().toISOString(), input.leaseId);
    return true;
  },
);

export const executeReadyDirectCleanupPlan = Effect.fn(
  "DirectResourceCleanupCoordinator.executeReady",
)(function* (input: {
  readonly operationId: string;
  readonly planDigest: string;
  readonly proofDigest: string;
  readonly resources: ReadonlyArray<DirectCleanupResource>;
  readonly executor: PreparedDirectResourceCleanupExecutor;
  readonly repository: DirectResourceCleanupRepositoryShape;
}) {
  return yield* withDirectCleanupCapacity(
    Effect.gen(function* () {
      const leaseId = crypto.randomUUID();
      const claimedAt = new Date().toISOString();
      const claimed = yield* input.repository.claimOperation({
        operationId: input.operationId,
        leaseId,
        claimedAt,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        expectedPlatform: `${process.platform}/${process.arch}`,
      });
      if (!claimed) return false;
      return yield* executeDirectCleanupPlan({
        ...input,
        leaseId,
        attemptCount: 0,
      }).pipe(
        Effect.ensuring(
          input.repository.releaseLease(input.operationId, leaseId).pipe(Effect.ignore),
        ),
      );
    }),
  );
});
