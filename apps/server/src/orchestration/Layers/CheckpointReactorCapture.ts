/**
 * Checkpoint capture helpers for CheckpointReactor.
 *
 * Extracted from CheckpointReactor.ts to keep that file under 500 lines.
 * All functions accept the services they need as parameters.
 */
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationCommand,
  type ProjectId,
  type ProviderSession,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
} from "@bigbud/contracts";
import { Effect, Option } from "effect";

import { parseTurnDiffFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import {
  checkpointRefForThreadTurn,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import { isGitRepository } from "../../git/Utils.ts";
import type { CheckpointStoreError } from "../../checkpointing/Errors.ts";
import type {
  CaptureCheckpointInput,
  DiffCheckpointsInput,
  RestoreCheckpointInput,
} from "../../checkpointing/Services/CheckpointStore.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import type { OrchestrationReadModel } from "@bigbud/contracts";

// Re-exported utility so callers don't need to import from Utils
export { isGitRepository as isGitWorkspace };

export const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

export function toTurnId(value: string | undefined): TurnId | null {
  return value === undefined ? null : TurnId.makeUnsafe(String(value));
}

export function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

export function checkpointStatusFromRuntime(
  status: string | undefined,
): "ready" | "missing" | "error" {
  switch (status) {
    case "failed":
      return "error";
    case "cancelled":
    case "interrupted":
      return "missing";
    case "completed":
    default:
      return "ready";
  }
}

// ---------------------------------------------------------------------------
// Activity helpers (curried — bind orchestrationEngine at construction time)
// ---------------------------------------------------------------------------

export function makeAppendRevertFailureActivity(orchestrationEngine: {
  dispatch: (
    cmd: OrchestrationCommand,
  ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError>;
}) {
  return (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("checkpoint-revert-failure"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "error",
        kind: "checkpoint.revert.failed",
        summary: "Checkpoint revert failed",
        payload: { turnCount: input.turnCount, detail: input.detail },
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
}

export function makeAppendCaptureFailureActivity(orchestrationEngine: {
  dispatch: (
    cmd: OrchestrationCommand,
  ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError>;
}) {
  return (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("checkpoint-capture-failure"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "error",
        kind: "checkpoint.capture.failed",
        summary: "Checkpoint capture failed",
        payload: { detail: input.detail },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
}

// ---------------------------------------------------------------------------
// Core capture logic
// ---------------------------------------------------------------------------

export function makeResolveSessionRuntimeForThread(
  orchestrationEngine: { getReadModel: () => Effect.Effect<OrchestrationReadModel, never> },
  providerService: { listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>> },
) {
  return Effect.fn("resolveSessionRuntimeForThread")(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<Option.Option<{ readonly threadId: ThreadId; readonly cwd: string }>, never> {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    const sessions = yield* providerService.listSessions();

    const findSessionWithCwd = (
      session: (typeof sessions)[number] | undefined,
    ): Option.Option<{ readonly threadId: ThreadId; readonly cwd: string }> => {
      if (!session?.cwd) return Option.none();
      return Option.some({ threadId: session.threadId, cwd: session.cwd });
    };

    if (thread) {
      const projectedSession = sessions.find((session) => session.threadId === thread.id);
      const fromProjected = findSessionWithCwd(projectedSession);
      if (Option.isSome(fromProjected)) return fromProjected;
    }

    return Option.none();
  });
}

export function makeResolveCheckpointCwd(
  resolveSessionRuntimeForThread: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<{ readonly threadId: ThreadId; readonly cwd: string }>, never>,
) {
  return Effect.fn("resolveCheckpointCwd")(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: { readonly projectId: ProjectId; readonly worktreePath: string | null };
    readonly projects: ReadonlyArray<{
      readonly id: ProjectId;
      readonly workspaceRoot: string | null;
    }>;
    readonly preferSessionRuntime: boolean;
  }): Effect.fn.Return<string | undefined, never> {
    const fromSession = yield* resolveSessionRuntimeForThread(input.threadId);
    const fromThread = resolveThreadWorkspaceCwd({
      thread: input.thread,
      projects: input.projects,
    });

    const cwd = input.preferSessionRuntime
      ? (Option.match(fromSession, { onNone: () => undefined, onSome: (r) => r.cwd }) ?? fromThread)
      : (fromThread ??
        Option.match(fromSession, { onNone: () => undefined, onSome: (r) => r.cwd }));

    if (!cwd) return undefined;
    if (!isGitRepository(cwd)) return undefined;
    return cwd;
  });
}

export function makeCaptureAndDispatchCheckpoint(
  orchestrationEngine: {
    dispatch: (
      cmd: OrchestrationCommand,
    ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError>;
  },
  checkpointStore: {
    hasCheckpointRef: (
      input: Omit<RestoreCheckpointInput, "fallbackToHead">,
    ) => Effect.Effect<boolean, CheckpointStoreError>;
    captureCheckpoint: (input: CaptureCheckpointInput) => Effect.Effect<void, CheckpointStoreError>;
    diffCheckpoints: (input: DiffCheckpointsInput) => Effect.Effect<string, CheckpointStoreError>;
  },
  receiptBus: {
    publish: (
      event: import("../Services/RuntimeReceiptBus.ts").OrchestrationRuntimeReceipt,
    ) => Effect.Effect<void>;
  },
  workspaceEntries: { invalidate: (cwd: string) => Effect.Effect<void> },
  appendCaptureFailureActivity: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly detail: string;
    readonly createdAt: string;
  }) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError>,
) {
  return Effect.fn("captureAndDispatchCheckpoint")(function* (input: {
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
  }): Effect.fn.Return<void, CheckpointStoreError | OrchestrationDispatchError> {
    const fromTurnCount = Math.max(0, input.turnCount - 1);
    const fromCheckpointRef = checkpointRefForThreadTurn(input.threadId, fromTurnCount);
    const targetCheckpointRef = checkpointRefForThreadTurn(input.threadId, input.turnCount);

    const fromCheckpointExists = yield* checkpointStore.hasCheckpointRef({
      cwd: input.cwd,
      checkpointRef: fromCheckpointRef,
    });
    if (!fromCheckpointExists) {
      yield* Effect.logWarning("checkpoint capture missing pre-turn baseline", {
        threadId: input.threadId,
        turnId: input.turnId,
        fromTurnCount,
      });
    }

    yield* checkpointStore.captureCheckpoint({
      cwd: input.cwd,
      checkpointRef: targetCheckpointRef,
    });
    yield* workspaceEntries.invalidate(input.cwd);

    const files = yield* checkpointStore
      .diffCheckpoints({
        cwd: input.cwd,
        fromCheckpointRef,
        toCheckpointRef: targetCheckpointRef,
        fallbackFromToHead: false,
      })
      .pipe(
        Effect.map((diff: string) =>
          parseTurnDiffFilesFromUnifiedDiff(diff).map((file) => ({
            path: file.path,
            kind: "modified" as const,
            additions: file.additions,
            deletions: file.deletions,
          })),
        ),
        Effect.tapError((error) =>
          appendCaptureFailureActivity({
            threadId: input.threadId,
            turnId: input.turnId,
            detail: `Checkpoint captured, but turn diff summary is unavailable: ${(error as { message?: string }).message}`,
            createdAt: input.createdAt,
          }),
        ),
        Effect.catch((error) =>
          Effect.logWarning("failed to derive checkpoint file summary", {
            threadId: input.threadId,
            turnId: input.turnId,
            turnCount: input.turnCount,
            detail: (error as { message?: string }).message,
          }).pipe(Effect.as([])),
        ),
      );

    const assistantMessageId =
      input.assistantMessageId ??
      input.thread.messages
        .toReversed()
        .find((entry) => entry.role === "assistant" && entry.turnId === input.turnId)?.id ??
      MessageId.makeUnsafe(`assistant:${input.turnId}`);

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: serverCommandId("checkpoint-turn-diff-complete"),
      threadId: input.threadId,
      turnId: input.turnId,
      completedAt: input.createdAt,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      files,
      assistantMessageId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "checkpoint.diff.finalized",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "turn.processing.quiesced",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("checkpoint-captured-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "info",
        kind: "checkpoint.captured",
        summary: "Checkpoint captured",
        payload: { turnCount: input.turnCount, status: input.status },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });
}

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
    const thread = readModel.threads.find((entry) => entry.id === event.threadId);
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
    const thread = readModel.threads.find((entry) => entry.id === threadId);
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
