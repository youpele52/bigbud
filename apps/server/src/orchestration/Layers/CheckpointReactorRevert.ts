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
  CheckpointRepositoryIdentity,
} from "../../checkpointing/Services/CheckpointStore.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
import { ProviderValidationError } from "../../provider/Errors.ts";
import type { ProviderServiceShape } from "../../provider/Services/ProviderService.ts";

export function makeHandleRevertRequested(
  orchestrationEngine: {
    getReadModel: () => Effect.Effect<OrchestrationReadModel, never>;
    dispatch: (
      cmd: OrchestrationCommand,
    ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError>;
  },
  providerService: {
    rewindConversation?: ProviderServiceShape["rewindConversation"];
    listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;
    getCapabilities?: (provider: ProviderSession["provider"]) => Effect.Effect<
      {
        readonly conversationRewind?: "transcript-and-files" | "files-only" | "unsupported";
      },
      ProviderServiceError
    >;
    rollbackConversation: (input: {
      readonly threadId: ThreadId;
      readonly numTurns: number;
    }) => Effect.Effect<void, ProviderServiceError>;
  },
  checkpointStore: {
    captureRepositoryIdentity: (
      cwd: string,
    ) => Effect.Effect<CheckpointRepositoryIdentity, CheckpointStoreError>;
    hasCheckpointRef: (
      input: Omit<RestoreCheckpointInput, "fallbackToHead">,
    ) => Effect.Effect<boolean, CheckpointStoreError>;
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

    if (thread.latestTurn?.state === "running" || thread.session?.status === "running") {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Rewind requires an idle provider session.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    if (providerService.getCapabilities) {
      const activeSession = (yield* providerService.listSessions()).find(
        (session) => session.threadId === sessionRuntime.value.threadId,
      );
      if (!activeSession) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail: "No active provider session is available for transcript rewind.",
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }
      const capabilities = yield* providerService
        .getCapabilities(activeSession.provider)
        .pipe(Effect.orElseSucceed(() => ({ conversationRewind: "unsupported" as const })));
      if (
        capabilities.conversationRewind !== undefined &&
        capabilities.conversationRewind !== "transcript-and-files"
      ) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail: "This provider cannot safely rewind transcript and files together.",
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );

    if (
      !Number.isSafeInteger(event.payload.turnCount) ||
      event.payload.turnCount < 0 ||
      event.payload.turnCount > currentTurnCount
    ) {
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

    const rolledBackTurns = Math.max(0, currentTurnCount - event.payload.turnCount);
    const activeSession = (yield* providerService.listSessions()).find(
      (session) => session.threadId === sessionRuntime.value.threadId,
    );
    const staleCheckpointRefs = thread.checkpoints
      .filter((checkpoint) => checkpoint.checkpointTurnCount > event.payload.turnCount)
      .map((checkpoint) => checkpoint.checkpointRef);
    let repositoryIdentity: CheckpointRepositoryIdentity | undefined;
    const restoreFiles = Effect.gen(function* () {
      const restored = yield* checkpointStore.restoreCheckpoint({
        cwd: sessionRuntime.value.cwd,
        checkpointRef: targetCheckpointRef,
        fallbackToHead: event.payload.turnCount === 0 && activeSession?.provider !== "codex",
        ...(repositoryIdentity ? { identity: repositoryIdentity, exactRef: true } : {}),
      });
      if (!restored)
        return yield* new ProviderValidationError({
          operation: "CheckpointReactor.revert",
          issue: `Transcript verified, but filesystem checkpoint ${event.payload.turnCount} is unavailable. New work remains blocked.`,
        });
      yield* workspaceEntries.invalidate(sessionRuntime.value.cwd);
    });
    const completeCanonical = orchestrationEngine
      .dispatch({
        type: "thread.revert.complete",
        commandId: serverCommandId("checkpoint-revert-complete"),
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        createdAt: now,
      })
      .pipe(Effect.asVoid);
    if (activeSession?.provider === "codex") {
      repositoryIdentity = yield* checkpointStore.captureRepositoryIdentity(
        sessionRuntime.value.cwd,
      );
      const checkpoints = thread.checkpoints.toSorted(
        (a, b) => a.checkpointTurnCount - b.checkpointTurnCount,
      );
      if (
        !providerService.rewindConversation ||
        checkpoints.length !== currentTurnCount ||
        checkpoints.some((checkpoint, index) => checkpoint.checkpointTurnCount !== index + 1)
      )
        return yield* new ProviderValidationError({
          operation: "CheckpointReactor.revert",
          issue: "Exact native checkpoint boundaries are unavailable or have gaps.",
        });
      const ids = checkpoints.map((checkpoint) => checkpoint.turnId);
      yield* providerService.rewindConversation<
        CheckpointStoreError | OrchestrationDispatchError | ProviderServiceError,
        never
      >(
        {
          threadId: sessionRuntime.value.threadId,
          operationId: event.eventId,
          expectedTurnIds: ids,
          targetTurnCount: event.payload.turnCount,
          currentTurnCount,
          retainedTurnId: ids[event.payload.turnCount - 1] ?? null,
          firstRemovedTurnId: ids[event.payload.turnCount] ?? null,
          checkpointRef: targetCheckpointRef,
          sessionEpoch: activeSession.sessionEpoch ?? 0,
        },
        {
          preflight: Effect.gen(function* () {
            if (
              !isGitRepository(sessionRuntime.value.cwd) ||
              !(yield* checkpointStore.hasCheckpointRef({
                cwd: sessionRuntime.value.cwd,
                checkpointRef: targetCheckpointRef,
                exactRef: true,
                identity: repositoryIdentity!,
              }))
            )
              return yield* new ProviderValidationError({
                operation: "CheckpointReactor.revert",
                issue:
                  "The exact filesystem checkpoint ref is unavailable; no native rewind was dispatched.",
              });
            const current = (yield* orchestrationEngine.getReadModel()).threads.find(
              (entry) => entry.id === thread.id,
            );
            if (
              !current ||
              current.deletedAt !== null ||
              current.deletingAt !== null ||
              current.pendingTurnStart != null ||
              current.latestTurn?.state === "running" ||
              current.session?.status === "running" ||
              (current.session?.sessionEpoch ?? 0) !== (activeSession.sessionEpoch ?? 0) ||
              JSON.stringify(current.checkpoints) !== JSON.stringify(thread.checkpoints)
            )
              return yield* new ProviderValidationError({
                operation: "CheckpointReactor.revert",
                issue: "Thread changed or is not idle inside the rewind lease.",
              });
          }),
          restoreFiles,
          completeCanonical,
        },
      );
    } else {
      if (rolledBackTurns > 0) {
        yield* providerService.rollbackConversation({
          threadId: sessionRuntime.value.threadId,
          numTurns: rolledBackTurns,
        });
      }

      yield* restoreFiles;
      yield* completeCanonical;
    }

    if (staleCheckpointRefs.length > 0) {
      yield* checkpointStore
        .deleteCheckpointRefs({
          cwd: sessionRuntime.value.cwd,
          checkpointRefs: staleCheckpointRefs,
        })
        .pipe(Effect.retry({ times: 2 }));
    }
  });
}
