import {
  ApprovalRequestId,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@bigbud/contracts";
import { Effect, Exit, Option, Ref, Stream } from "effect";

import type { ProjectionPendingApprovalRepository } from "../src/persistence/Services/ProjectionPendingApprovals.ts";
import type { OrchestrationEngineShape } from "../src/orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import type { OrchestrationRuntimeReceipt } from "../src/orchestration/Services/RuntimeReceiptBus.ts";

import { waitFor } from "./OrchestrationEngineHarness.integration.shared.ts";
import type {
  OrchestrationIntegrationHarness,
  PendingApprovalRow,
} from "./OrchestrationEngineHarness.integration.types.ts";

interface CreateHarnessRuntimeControlsInput {
  readonly engine: OrchestrationEngineShape;
  readonly snapshotQuery: ProjectionSnapshotQuery["Service"];
  readonly pendingApprovalRepository: ProjectionPendingApprovalRepository["Service"];
  readonly receiptHistory: Ref.Ref<ReadonlyArray<OrchestrationRuntimeReceipt>>;
  readonly closeScope: Effect.Effect<void>;
  readonly disposeRuntime: () => Promise<void>;
}

export function createHarnessRuntimeControls({
  engine,
  snapshotQuery,
  pendingApprovalRepository,
  receiptHistory,
  closeScope,
  disposeRuntime,
}: CreateHarnessRuntimeControlsInput): Pick<
  OrchestrationIntegrationHarness,
  "waitForThread" | "waitForDomainEvent" | "waitForPendingApproval" | "waitForReceipt" | "dispose"
> {
  const waitForThread: OrchestrationIntegrationHarness["waitForThread"] = (
    threadId,
    predicate,
    timeoutMs,
  ) =>
    waitFor(
      snapshotQuery
        .getSnapshot()
        .pipe(
          Effect.map(
            (snapshot) => snapshot.threads.find((thread) => thread.id === threadId) ?? null,
          ),
        ),
      (thread): thread is OrchestrationThread => thread !== null && predicate(thread),
      `projected thread '${threadId}'`,
      timeoutMs,
    ) as Effect.Effect<OrchestrationThread, never>;

  const waitForDomainEvent: OrchestrationIntegrationHarness["waitForDomainEvent"] = (
    predicate,
    timeoutMs,
  ) =>
    waitFor(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): ReadonlyArray<OrchestrationEvent> => Array.from(chunk)),
      ),
      (events) => events.some(predicate),
      "domain event",
      timeoutMs,
    );

  const waitForPendingApproval: OrchestrationIntegrationHarness["waitForPendingApproval"] = (
    requestId,
    predicate,
    timeoutMs,
  ) =>
    waitFor(
      pendingApprovalRepository
        .getByRequestId({ requestId: ApprovalRequestId.makeUnsafe(requestId) })
        .pipe(
          Effect.map((row) =>
            Option.match(row, {
              onNone: () => null,
              onSome: (value): PendingApprovalRow => ({
                status: value.status,
                decision: value.decision,
                resolvedAt: value.resolvedAt,
              }),
            }),
          ),
        ),
      (row): row is PendingApprovalRow => row !== null && predicate(row),
      `pending approval '${requestId}'`,
      timeoutMs,
    ) as Effect.Effect<PendingApprovalRow, never>;

  function waitForReceipt(
    predicate: (receipt: OrchestrationRuntimeReceipt) => boolean,
    timeoutMs?: number,
  ): Effect.Effect<OrchestrationRuntimeReceipt, never>;
  function waitForReceipt<Receipt extends OrchestrationRuntimeReceipt>(
    predicate: (receipt: OrchestrationRuntimeReceipt) => receipt is Receipt,
    timeoutMs?: number,
  ): Effect.Effect<Receipt, never>;
  function waitForReceipt(
    predicate: (receipt: OrchestrationRuntimeReceipt) => boolean,
    timeoutMs?: number,
  ) {
    const readMatchingReceipt = Ref.get(receiptHistory).pipe(
      Effect.map((history) => history.find(predicate)),
    );

    return waitFor(
      readMatchingReceipt,
      (receipt): receipt is OrchestrationRuntimeReceipt => receipt !== undefined,
      "runtime receipt",
      timeoutMs,
    );
  }

  let disposed = false;
  const dispose = Effect.gen(function* () {
    if (disposed) {
      return;
    }
    disposed = true;

    const closeScopeExit = yield* Effect.exit(closeScope);
    const disposeRuntimeExit = yield* Effect.exit(Effect.promise(disposeRuntime));

    const failureCause = Exit.isFailure(closeScopeExit)
      ? closeScopeExit.cause
      : Exit.isFailure(disposeRuntimeExit)
        ? disposeRuntimeExit.cause
        : null;

    if (failureCause) {
      return yield* Effect.failCause(failureCause);
    }
  });

  return {
    waitForThread,
    waitForDomainEvent,
    waitForPendingApproval,
    waitForReceipt,
    dispose,
  };
}
