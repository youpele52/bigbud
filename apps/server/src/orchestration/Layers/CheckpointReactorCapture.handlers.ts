import {
  type MessageId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ProjectId,
  ThreadId,
  type ProviderRuntimeEvent,
  type TurnId,
} from "@bigbud/contracts";
import { Effect } from "effect";

import type { CheckpointStoreError } from "../../checkpointing/Errors.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { checkpointStatusFromRuntime, sameId, toTurnId } from "./CheckpointReactorCapture.ts";

type ThreadReadModel = {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
  readonly session?: { readonly activeTurnId: TurnId | null } | null;
  readonly checkpoints: ReadonlyArray<{
    readonly turnId: TurnId | null;
    readonly status: "ready" | "missing" | "error";
    readonly checkpointTurnCount: number;
  }>;
  readonly messages: ReadonlyArray<{
    readonly id: MessageId;
    readonly role: string;
    readonly turnId: TurnId | null;
  }>;
};

export function makeCaptureCheckpointFromTurnCompletion(
  orchestrationEngine: { getReadModel: () => Effect.Effect<OrchestrationReadModel, never> },
  resolveCheckpointCwd: (input: {
    readonly threadId: ThreadId;
    readonly thread: { readonly projectId: ProjectId; readonly worktreePath: string | null };
    readonly projects: ReadonlyArray<{
      readonly id: ProjectId;
      readonly workspaceRoot: string | null;
    }>;
    readonly preferSessionRuntime: boolean;
  }) => Effect.Effect<string | undefined, never>,
  captureAndDispatchCheckpoint: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly thread: {
      readonly messages: ReadonlyArray<{
        readonly id: MessageId;
        readonly role: string;
        readonly turnId: TurnId | null;
      }>;
    };
    readonly cwd: string;
    readonly turnCount: number;
    readonly status: "ready" | "missing" | "error";
    readonly assistantMessageId: MessageId | undefined;
    readonly createdAt: string;
  }) => Effect.Effect<void, CheckpointStoreError | OrchestrationDispatchError>,
) {
  return Effect.fn("captureCheckpointFromTurnCompletion")(function* (
    event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>,
  ): Effect.fn.Return<void, CheckpointStoreError | OrchestrationDispatchError> {
    const turnId = toTurnId(event.turnId);
    if (!turnId) return;

    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === event.threadId) as
      | ThreadReadModel
      | undefined;
    if (!thread) return;

    if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, turnId)) return;

    if (
      thread.checkpoints.some(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
      )
    ) {
      return;
    }

    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId: thread.id,
      thread,
      projects: readModel.projects,
      preferSessionRuntime: true,
    });
    if (!checkpointCwd) return;

    const existingPlaceholder = thread.checkpoints.find(
      (checkpoint) => checkpoint.turnId === turnId && checkpoint.status === "missing",
    );
    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    const nextTurnCount = existingPlaceholder
      ? existingPlaceholder.checkpointTurnCount
      : currentTurnCount + 1;

    yield* captureAndDispatchCheckpoint({
      threadId: thread.id,
      turnId,
      thread,
      cwd: checkpointCwd,
      turnCount: nextTurnCount,
      status: checkpointStatusFromRuntime(event.payload.state),
      assistantMessageId: undefined,
      createdAt: event.createdAt,
    });
  });
}

export function makeCaptureCheckpointFromPlaceholder(
  orchestrationEngine: { getReadModel: () => Effect.Effect<OrchestrationReadModel, never> },
  resolveCheckpointCwd: (input: {
    readonly threadId: ThreadId;
    readonly thread: { readonly projectId: ProjectId; readonly worktreePath: string | null };
    readonly projects: ReadonlyArray<{
      readonly id: ProjectId;
      readonly workspaceRoot: string | null;
    }>;
    readonly preferSessionRuntime: boolean;
  }) => Effect.Effect<string | undefined, never>,
  captureAndDispatchCheckpoint: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly thread: {
      readonly messages: ReadonlyArray<{
        readonly id: MessageId;
        readonly role: string;
        readonly turnId: TurnId | null;
      }>;
    };
    readonly cwd: string;
    readonly turnCount: number;
    readonly status: "ready" | "missing" | "error";
    readonly assistantMessageId: MessageId | undefined;
    readonly createdAt: string;
  }) => Effect.Effect<void, CheckpointStoreError | OrchestrationDispatchError>,
) {
  return Effect.fn("captureCheckpointFromPlaceholder")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.turn-diff-completed" }>,
  ): Effect.fn.Return<void, CheckpointStoreError | OrchestrationDispatchError> {
    const { threadId, turnId, checkpointTurnCount, status } = event.payload;

    if (status !== "missing") return;

    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId) as
      | ThreadReadModel
      | undefined;
    if (!thread) {
      yield* Effect.logWarning("checkpoint capture from placeholder skipped: thread not found", {
        threadId,
      });
      return;
    }

    if (
      thread.checkpoints.some(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
      )
    ) {
      yield* Effect.logDebug(
        "checkpoint capture from placeholder skipped: real checkpoint already exists",
        { threadId, turnId },
      );
      return;
    }

    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId,
      thread,
      projects: readModel.projects,
      preferSessionRuntime: true,
    });
    if (!checkpointCwd) return;

    yield* captureAndDispatchCheckpoint({
      threadId,
      turnId,
      thread,
      cwd: checkpointCwd,
      turnCount: checkpointTurnCount,
      status: "ready",
      assistantMessageId: event.payload.assistantMessageId ?? undefined,
      createdAt: event.payload.completedAt,
    });
  });
}
