/**
 * Decider cases for sleep and wake recovery commands.
 *
 * `thread.recovery.set` is the coordinator publishing a new recovery state.
 * `thread.recovery.resolve` is the user acting on a recovery prompt. The decider only records
 * the user's choice as a `thread.recovery-updated` event with `resolvedAction`; the recovery
 * coordinator observes that event and performs the send, so the decision stays with one owner.
 */
import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "@bigbud/contracts";
import type {
  ThreadRecovery,
  ThreadRecoveryResolveAction,
} from "@bigbud/contracts/orchestration/orchestration.recovery.ts";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { requireThread } from "./commandInvariants.ts";
import { withEventBase } from "./deciderHelpers.ts";

export type ThreadRecoveryCommand = Extract<
  OrchestrationCommand,
  { type: "thread.recovery.set" | "thread.recovery.resolve" }
>;

const RESOLVABLE_STATUSES: Record<ThreadRecoveryResolveAction, ReadonlySet<string>> = {
  continue: new Set(["awaiting-user"]),
  dismiss: new Set(["awaiting-user", "parked", "provider-continued", "continued"]),
  retry: new Set(["parked"]),
  "keep-waiting": new Set(["awaiting-user"]),
  "stop-and-continue": new Set(["awaiting-user"]),
};

/**
 * Whether a user's action applies to a recovery status. The decider checks the projection; the
 * coordinator checks the intent again, because the projection may be stale.
 */
export function isRecoveryActionApplicable(
  action: ThreadRecoveryResolveAction,
  status: string,
): boolean {
  return RESOLVABLE_STATUSES[action].has(status);
}

/** The visible state right after a user's action, before the coordinator acts on it. */
export function recoveryAfterResolve(
  current: ThreadRecovery,
  action: ThreadRecoveryResolveAction,
  occurredAt: string,
): ThreadRecovery | null {
  switch (action) {
    case "dismiss":
      return null;
    case "keep-waiting":
      return { ...current, status: "observing", reason: null, updatedAt: occurredAt };
    case "continue":
    case "retry":
    case "stop-and-continue":
      return { ...current, status: "continuing", updatedAt: occurredAt };
  }
}

export const decideThreadRecoveryCommand = Effect.fn("decideThreadRecoveryCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: ThreadRecoveryCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
  OrchestrationCommandInvariantError
> {
  const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
  const base = withEventBase({
    aggregateKind: "thread",
    aggregateId: command.threadId,
    occurredAt: command.createdAt,
    commandId: command.commandId,
  });
  if (command.type === "thread.recovery.set") {
    const messageId = command.messageId ?? command.recovery?.messageId;
    return [
      {
        ...base,
        type: "thread.recovery-updated",
        payload: {
          threadId: command.threadId,
          recovery: command.recovery,
          ...(messageId ? { messageId } : {}),
          createdAt: command.createdAt,
        },
      },
    ];
  }
  const current = thread.recovery ?? null;
  // A stale or repeated click is a no-op, never an error: the prompt may have moved on.
  if (current === null) return [];
  if (command.messageId !== undefined && command.messageId !== current.messageId) return [];
  if (!isRecoveryActionApplicable(command.action, current.status)) return [];
  return [
    {
      ...base,
      type: "thread.recovery-updated",
      payload: {
        threadId: command.threadId,
        recovery: recoveryAfterResolve(current, command.action, command.createdAt),
        messageId: current.messageId,
        resolvedAction: command.action,
        createdAt: command.createdAt,
      },
    },
  ];
});
