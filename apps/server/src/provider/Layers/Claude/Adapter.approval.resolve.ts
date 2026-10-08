import type { ApprovalRequestId } from "@bigbud/contracts";
import { Deferred, Effect, Exit } from "effect";
import type { ClaudeSessionContext } from "./Adapter.types.ts";
import {
  trimRequestLedger,
  type ResolvedClaudeRequestLedgerEntry,
} from "./Adapter.requestLedger.ts";

/** Claim terminal publication before yielding. Only this owner commits the SDK result. */
export function resolveClaudeRequest<A>(
  context: ClaudeSessionContext,
  requestId: ApprovalRequestId,
  signal: AbortSignal,
  publish: (cancelled: () => boolean) => Effect.Effect<void>,
  finish: (cancelled: boolean) => {
    readonly entry: ResolvedClaudeRequestLedgerEntry;
    readonly result: A;
  },
): Effect.Effect<A> {
  return Effect.suspend(() => {
    const pending = context.requestLedger.get(requestId);
    if (!pending || pending.state !== "pending") {
      // Stop may have settled the owner between its wait and this claim.
      return Effect.sync(() => finish(true).result);
    }
    const resolving = { ...pending, state: "resolving" as const, cancelled: false };
    context.requestLedger.set(requestId, resolving);
    const cancelled = () =>
      resolving.cancelled ||
      signal.aborted ||
      context.stopped ||
      context.session.status === "closed";
    let result: A;
    return publish(cancelled).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          // No grant or cached allow exists before publication completes. A late
          // cancellation overrides the UI decision, and publication failure denies.
          const completed = finish(Exit.isFailure(exit) || cancelled());
          context.requestLedger.set(requestId, completed.entry);
          trimRequestLedger(context.requestLedger);
          result = completed.result;
          Deferred.doneUnsafe(pending.completion, Effect.void);
        }),
      ),
      Effect.map(() => result),
    );
  });
}
