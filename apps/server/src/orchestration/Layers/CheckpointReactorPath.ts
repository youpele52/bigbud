import {
  EventId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@bigbud/contracts";
import { Effect } from "effect";

import {
  isValidWorkspaceRelativePath,
  pathCheckpointRefForThreadPath,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import type { CheckpointStoreError } from "../../checkpointing/Errors.ts";
import type { PathCheckpointInput } from "../../checkpointing/Services/CheckpointStore.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { serverCommandId } from "./CheckpointReactorCapture.ts";

type PathCheckpointEvent = Extract<
  OrchestrationEvent,
  | { type: "thread.path-checkpoint-capture-requested" }
  | { type: "thread.path-checkpoint-restore-requested" }
>;

export function makeHandlePathCheckpointRequested(
  orchestrationEngine: {
    getReadModel: () => Effect.Effect<OrchestrationReadModel, never>;
    dispatch: (
      command: OrchestrationCommand,
    ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError>;
  },
  checkpointStore: {
    isGitRepository: (cwd: string) => Effect.Effect<boolean, CheckpointStoreError>;
    capturePathCheckpoint: (
      input: PathCheckpointInput,
    ) => Effect.Effect<void, CheckpointStoreError>;
    restorePathCheckpoint: (
      input: PathCheckpointInput,
    ) => Effect.Effect<boolean, CheckpointStoreError>;
  },
  workspaceEntries: { invalidate: (cwd: string) => Effect.Effect<void> },
) {
  return Effect.fn("handlePathCheckpointRequested")(function* (event: PathCheckpointEvent) {
    const now = new Date().toISOString();
    const operation =
      event.type === "thread.path-checkpoint-capture-requested" ? "capture" : "restore";
    const appendActivity = (tone: "info" | "error", detail: string) =>
      orchestrationEngine
        .dispatch({
          type: "thread.activity.append",
          commandId: serverCommandId(`path-checkpoint-${operation}-${tone}`),
          threadId: event.payload.threadId,
          activity: {
            id: EventId.makeUnsafe(crypto.randomUUID()),
            tone,
            kind: `path-checkpoint.${operation}.${tone === "info" ? "completed" : "failed"}`,
            summary: `Path checkpoint ${operation}${tone === "info" ? "d" : " failed"}`,
            payload: { path: event.payload.path, detail },
            turnId: null,
            createdAt: now,
          },
          createdAt: now,
        })
        .pipe(Effect.catch(() => Effect.void));
    const execute = Effect.gen(function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find((entry) => entry.id === event.payload.threadId);
      if (!thread) return;
      if (thread.latestTurn?.state === "running" || thread.session?.status === "running") {
        yield* appendActivity(
          "error",
          "Interrupt the running turn before changing a path checkpoint.",
        );
        return;
      }
      if (!isValidWorkspaceRelativePath(event.payload.path)) {
        yield* appendActivity(
          "error",
          "Path must be relative, contain no traversal, and must not include .git.",
        );
        return;
      }
      const cwd = resolveThreadWorkspaceCwd({ thread, projects: readModel.projects });
      if (!cwd || !(yield* checkpointStore.isGitRepository(cwd))) {
        yield* appendActivity("error", "Path checkpoints require a git workspace for this thread.");
        return;
      }
      const input = {
        cwd,
        path: event.payload.path,
        checkpointRef: pathCheckpointRefForThreadPath(thread.id, event.payload.path),
      };
      if (operation === "capture") {
        yield* checkpointStore.capturePathCheckpoint(input);
        yield* workspaceEntries.invalidate(cwd);
        yield* appendActivity("info", "Captured workspace path checkpoint.");
        return;
      }
      if (!(yield* checkpointStore.restorePathCheckpoint(input))) {
        yield* appendActivity("error", "No captured checkpoint exists for this path.");
        return;
      }
      yield* workspaceEntries.invalidate(cwd);
      yield* appendActivity("info", "Restored workspace path checkpoint.");
    });
    yield* execute.pipe(
      Effect.catch((error) =>
        appendActivity(
          "error",
          error instanceof Error ? error.message : "Path checkpoint operation failed unexpectedly.",
        ),
      ),
    );
  });
}
