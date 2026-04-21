/**
 * Revert handler for CheckpointReactor.
 *
 * Extracted from CheckpointReactor.ts to keep that file under 500 lines.
 */
import { ThreadId, type OrchestrationCommand, type ProviderSession } from "@bigbud/contracts";
import { Effect, Option } from "effect";

import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { isGitRepository } from "../../git/Utils.ts";
import { serverCommandId } from "./CheckpointReactorCapture.ts";
import type { OrchestrationEvent, OrchestrationReadModel } from "@bigbud/contracts";
import type { CheckpointStoreError } from "../../checkpointing/Errors.ts";
import type {
  RestoreCheckpointInput,
  DeleteCheckpointRefsInput,
} from "../../checkpointing/Services/CheckpointStore.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";

export function makeHandleRevertRequested(
  orchestrationEngine: {
    getReadModel: () => Effect.Effect<OrchestrationReadModel, never>;
    dispatch: (
      cmd: OrchestrationCommand,
    ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError>;
  },
  providerService: {
    listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;
    rollbackConversation: (input: {
      readonly threadId: ThreadId;
      readonly numTurns: number;
    }) => Effect.Effect<void, ProviderServiceError>;
  },
  checkpointStore: {
    restoreCheckpoint: (
      input: RestoreCheckpointInput,
    ) => Effect.Effect<boolean, CheckpointStoreError>;
    deleteCheckpointRefs: (
      input: DeleteCheckpointRefsInput,
    ) => Effect.Effect<void, CheckpointStoreError>;
  },
  workspaceEntries: { invalidate: (cwd: string) => Effect.Effect<void> },
  appendRevertFailureActivity: (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly detail: string;
    readonly createdAt: string;
  }) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError>,
  resolveSessionRuntimeForThread: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<{ readonly threadId: ThreadId; readonly cwd: string }>, never>,
) {
  return Effect.fn("handleRevertRequested")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.checkpoint-revert-requested" }>,
  ): Effect.fn.Return<
    void,
    CheckpointStoreError | OrchestrationDispatchError | ProviderServiceError
  > {
    const now = new Date().toISOString();

    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === event.payload.threadId);
    if (!thread) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Thread was not found in read model.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const sessionRuntime = yield* resolveSessionRuntimeForThread(event.payload.threadId);
    if (Option.isNone(sessionRuntime)) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "No active provider session with workspace cwd is bound to this thread.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }
    if (!isGitRepository(sessionRuntime.value.cwd)) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Checkpoints are unavailable because this project is not a git repository.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );

    if (event.payload.turnCount > currentTurnCount) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Checkpoint turn count ${event.payload.turnCount} exceeds current turn count ${currentTurnCount}.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const targetCheckpointRef =
      event.payload.turnCount === 0
        ? checkpointRefForThreadTurn(event.payload.threadId, 0)
        : thread.checkpoints.find(
            (checkpoint) => checkpoint.checkpointTurnCount === event.payload.turnCount,
          )?.checkpointRef;

    if (!targetCheckpointRef) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Checkpoint ref for turn ${event.payload.turnCount} is unavailable in read model.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const restored = yield* checkpointStore.restoreCheckpoint({
      cwd: sessionRuntime.value.cwd,
      checkpointRef: targetCheckpointRef,
      fallbackToHead: event.payload.turnCount === 0,
    });
    if (!restored) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Filesystem checkpoint is unavailable for turn ${event.payload.turnCount}.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    yield* workspaceEntries.invalidate(sessionRuntime.value.cwd);

    const rolledBackTurns = Math.max(0, currentTurnCount - event.payload.turnCount);
    if (rolledBackTurns > 0) {
      yield* providerService.rollbackConversation({
        threadId: sessionRuntime.value.threadId,
        numTurns: rolledBackTurns,
      });
    }

    const staleCheckpointRefs = thread.checkpoints
      .filter((checkpoint) => checkpoint.checkpointTurnCount > event.payload.turnCount)
      .map((checkpoint) => checkpoint.checkpointRef);

    if (staleCheckpointRefs.length > 0) {
      yield* checkpointStore.deleteCheckpointRefs({
        cwd: sessionRuntime.value.cwd,
        checkpointRefs: staleCheckpointRefs,
      });
    }

    yield* orchestrationEngine
      .dispatch({
        type: "thread.revert.complete",
        commandId: serverCommandId("checkpoint-revert-complete"),
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        createdAt: now,
      })
      .pipe(
        Effect.catch((error) =>
          appendRevertFailureActivity({
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: (error as { message?: string }).message ?? String(error),
            createdAt: now,
          }),
        ),
        Effect.asVoid,
      );
  });
}
