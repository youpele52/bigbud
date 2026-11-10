import { CommandId, type MessageId, type ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect } from "effect";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ThreadDelegationRepositoryShape } from "../persistence/Services/ThreadDelegations.ts";
import type { ThreadCoordinationDeps } from "./ThreadCoordinationConfirmation.ts";
import {
  isThreadCoordinationExempt,
  requireThreadCoordinationConfirmation,
} from "./ThreadOrchestrationTools.access.ts";
import { resolveThreadToolParticipants } from "./ThreadOrchestrationTools.participants.ts";
import { stableThreadToolId } from "./ThreadOrchestrationTools.origins.ts";
import { lockThreadTitle } from "./ThreadTitleLock.ts";

/** Allows trusted bridge code to query the exact engine receipt after a lost acknowledgement. */
export function canonicalRenameThreadCommandId(input: {
  readonly threadId: ThreadId;
  readonly sourceMessageId: MessageId;
  readonly invocationId: string;
}): CommandId {
  return CommandId.makeUnsafe(
    stableThreadToolId(
      "command",
      JSON.stringify([input.threadId, input.sourceMessageId, input.invocationId, "rename"]),
    ),
  );
}

const hasCommittedRename = Effect.fn("hasCommittedThreadRename")(function* (
  orchestrationEngine: OrchestrationEngineShape,
  commandId: CommandId,
  threadId: ThreadId,
  title: string,
) {
  if (commandId.startsWith("agent:") || !orchestrationEngine.readEventsByCommandId) return false;
  const events = yield* orchestrationEngine.readEventsByCommandId(commandId);
  return events.some(
    (event) =>
      event.commandId === commandId &&
      event.type === "thread.meta-updated" &&
      event.payload.threadId === threadId &&
      event.payload.title === title,
  );
});

/** Renames canonical metadata, never a provider-native session or attached transcript. */
export const renameThreadViaOrchestration = Effect.fn("renameThreadViaOrchestration")(
  function* (input: {
    readonly orchestrationEngine: OrchestrationEngineShape;
    readonly threadDelegationRepository: ThreadDelegationRepositoryShape;
    /** Cross-project confirmation handles; absent means cross-project renames are refused. */
    readonly coordination?: ThreadCoordinationDeps | undefined;
    /** Authenticated caller; never replaced by the requested target. */
    readonly threadId: ThreadId;
    readonly targetThreadId?: ThreadId;
    readonly title: string;
    readonly invocationId?: string;
    readonly sourceMessageId?: MessageId;
  }) {
    const title = input.title.trim();
    if (!title) return yield* Effect.fail(new Error("Thread title cannot be empty."));
    if (title.length > 200) {
      return yield* Effect.fail(new Error("Thread title must be between 1 and 200 characters."));
    }
    if (input.targetThreadId !== undefined && !input.targetThreadId.trim()) {
      return yield* Effect.fail(new Error("Target thread ID cannot be empty."));
    }
    if (
      (input.invocationId !== undefined || input.sourceMessageId !== undefined) &&
      (!input.invocationId?.trim() || !input.sourceMessageId?.trim())
    ) {
      return yield* Effect.fail(
        new Error("invocationId and sourceMessageId are required together."),
      );
    }

    const targetThreadId = input.targetThreadId ?? input.threadId;
    const { callerThread, targetThread } = yield* resolveThreadToolParticipants({
      ...input,
      callerThreadId: input.threadId,
      threadId: targetThreadId,
      operation: "rename",
    });

    // Existing engine receipts replay identical commands and reject changed material.
    const commandId = CommandId.makeUnsafe(
      input.invocationId && input.sourceMessageId
        ? canonicalRenameThreadCommandId({
            threadId: input.threadId,
            sourceMessageId: input.sourceMessageId,
            invocationId: input.invocationId,
          })
        : `agent:thread-rename:${crypto.randomUUID()}`,
    );
    const exempt = yield* isThreadCoordinationExempt({
      threadDelegationRepository: input.threadDelegationRepository,
      callerThread,
      targetThread,
      targetProjectId: targetThread.projectId,
    });
    if (!exempt) {
      // Replay first: an exact committed rename (e.g. after a restart lost the grant) returns
      // without issuing a challenge or consuming a denial. Random-ID renames have nothing to
      // replay. Exempt targets keep relying on engine receipt replay at dispatch, unchanged.
      if (yield* hasCommittedRename(input.orchestrationEngine, commandId, targetThreadId, title)) {
        lockThreadTitle(targetThreadId);
        return { title, threadId: targetThreadId, commandId } as const;
      }
      const access = yield* requireThreadCoordinationConfirmation({
        orchestrationEngine: input.orchestrationEngine,
        coordination: input.coordination,
        callerThread,
        targetThread,
        targetProjectId: targetThread.projectId,
      });
      if (access.kind !== "allowed") return access.result;
    }
    yield* input.orchestrationEngine.dispatch({
      type: "thread.meta.update",
      commandId,
      threadId: targetThreadId,
      title,
    });
    lockThreadTitle(targetThreadId);
    return { title, threadId: targetThreadId, commandId } as const;
  },
);
