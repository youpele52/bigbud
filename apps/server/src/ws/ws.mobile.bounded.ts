import { OrchestrationGetMobileThreadError, type ThreadId } from "@bigbud/contracts";
import { Effect, Schema } from "effect";
import { MobileRecoveryBaselineError } from "@bigbud/contracts/server/mobile.recovery";

import type { WsRpcContext } from "./wsRpcContext.ts";

type MobileReadContext = Pick<
  WsRpcContext,
  "projectionCatalogQuery" | "projectionOperationalStateQuery" | "projectionSnapshotQuery"
>;

const threadNotFound = () =>
  new OrchestrationGetMobileThreadError({ message: "Thread not found." });

/**
 * The legacy mobile `getSnapshot`: the bounded mobile recovery baseline's summary, which already
 * trims every thread to a short preview. The full projection snapshot is never built for mobile.
 */
export const readBoundedMobileSnapshot = Effect.fn("readBoundedMobileSnapshot")(function* (
  context: MobileReadContext,
) {
  const getBaseline = context.projectionSnapshotQuery.getMobileRecoveryBaseline;
  if (getBaseline === undefined) {
    return yield* Effect.fail(new Error("Mobile baseline is unavailable on this server."));
  }
  const baseline = yield* getBaseline(null);
  return baseline.snapshot;
});

/** Legacy reads share the mobile SQL exemptions and serialized budget, never desktop detail. */
export const readBoundedMobileThread = Effect.fn("readBoundedMobileThread")(function* (
  context: MobileReadContext,
  threadId: ThreadId,
) {
  const getBaseline = context.projectionSnapshotQuery.getMobileRecoveryBaseline;
  if (!getBaseline) {
    return yield* new OrchestrationGetMobileThreadError({
      message: "Mobile thread reads are unavailable on this server.",
    });
  }
  const baseline = yield* getBaseline(threadId).pipe(
    Effect.mapError(
      (error) =>
        new OrchestrationGetMobileThreadError({
          message: Schema.is(MobileRecoveryBaselineError)(error.cause)
            ? error.cause.message
            : "Mobile thread could not be loaded.",
        }),
    ),
  );
  if (baseline.selectedThread?.status !== "present") return yield* threadNotFound();
  return baseline.selectedThread.thread;
});
