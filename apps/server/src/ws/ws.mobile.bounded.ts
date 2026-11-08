import { OrchestrationGetMobileThreadError, type ThreadId } from "@bigbud/contracts";
import { Effect, Option, Schema } from "effect";

import { buildBoundedMobileThread } from "../mobile/mobileThread.bounded.ts";
import { ProjectionThreadDetailNotFoundError } from "../orchestration/Services/ProjectionCatalogQuery.ts";
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

/** One mobile thread from the operational shell and the bounded selected-thread detail. */
export const readBoundedMobileThread = Effect.fn("readBoundedMobileThread")(function* (
  context: MobileReadContext,
  threadId: ThreadId,
) {
  if (Option.isNone(context.projectionOperationalStateQuery)) {
    return yield* new OrchestrationGetMobileThreadError({
      message: "Mobile thread reads are unavailable on this server.",
    });
  }
  const detail = yield* context.projectionCatalogQuery
    .getSelectedThreadDetail({ threadId })
    .pipe(
      Effect.catchIf(Schema.is(ProjectionThreadDetailNotFoundError), () =>
        Effect.fail(threadNotFound()),
      ),
    );
  const shell =
    yield* context.projectionOperationalStateQuery.value.getThreadOperationalState(threadId);
  const thread = Option.flatMap(shell, (model) =>
    Option.fromNullishOr(model.threads.find((entry) => entry.id === threadId)),
  );
  if (Option.isNone(thread)) {
    return yield* threadNotFound();
  }
  return buildBoundedMobileThread(thread.value, detail);
});
