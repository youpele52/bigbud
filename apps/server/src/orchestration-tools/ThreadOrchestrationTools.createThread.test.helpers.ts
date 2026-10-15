import { MessageId, ProjectId, ThreadId, TurnId } from "@bigbud/contracts";
import { Effect, Option } from "effect";
import { vi } from "vitest";

import type { ThreadDelegationRepositoryShape } from "../persistence/Services/ThreadDelegations.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionThreadWatchRepositoryShape } from "../persistence/Services/ProjectionThreadWatches.ts";
import type { PersistenceSqlError } from "../persistence/Errors.ts";

export const DELEGATION_CREATED_AT = "2026-10-15T10:00:00.000Z";
export const callerThreadId = ThreadId.makeUnsafe("caller-thread");
export const callerProjectId = ProjectId.makeUnsafe("caller-project");
export const targetProjectId = ProjectId.makeUnsafe("target-project");
export const sourceMessageId = MessageId.makeUnsafe("source-message");

export const callerThread = {
  id: callerThreadId,
  projectId: callerProjectId,
  title: "Parent",
  modelSelection: { provider: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  providerRuntimeExecutionTargetId: "provider-target",
  workspaceExecutionTargetId: "workspace-target",
  executionTargetId: "execution-target",
  deletedAt: null,
  deletingAt: null,
};

export function makeSystem(
  parent: Omit<typeof callerThread, "modelSelection"> & {
    modelSelection: { provider: string; model: string; subProviderID?: string };
  } = callerThread,
) {
  const dispatch = vi.fn((_command: unknown) => Effect.succeed({ sequence: 1 }));
  const engine = {
    getReadModel: () =>
      Effect.succeed({
        projects: [
          { id: callerProjectId, deletedAt: null, deletingAt: null },
          { id: targetProjectId, deletedAt: null, deletingAt: null },
        ],
        threads: [parent],
      }),
    dispatch,
  } as unknown as OrchestrationEngineShape;
  const delegation = {
    delegationId: "delegation-1",
    callerThreadId,
    sourceMessageId,
    invocationId: "invocation-1",
    parentDelegationId: null,
    rootDelegationId: "delegation-1",
    depth: 0,
    targetKind: "project",
    targetProjectId: callerProjectId,
    targetCanonicalWorkspace: null,
    childThreadId: ThreadId.makeUnsafe("child-thread"),
    childTurnId: TurnId.makeUnsafe("child-turn"),
    createdProjectId: null,
    state: "reserved" as const,
    resultJson: null,
    errorJson: null,
    createdAt: DELEGATION_CREATED_AT,
    updatedAt: DELEGATION_CREATED_AT,
  };
  let getByInvocation: ThreadDelegationRepositoryShape["getByInvocation"] = () =>
    Effect.succeed(Option.none());
  const addActiveWatch = vi.fn(
    (_input: unknown): Effect.Effect<void, PersistenceSqlError> => Effect.void,
  );
  const updateState = vi.fn(() => Effect.void);
  const storeResult = vi.fn(
    (_input: Parameters<ThreadDelegationRepositoryShape["storeResult"]>[0]) => Effect.void,
  );
  const projectionThreadWatchRepository: ProjectionThreadWatchRepositoryShape = {
    addActiveWatch,
    replaceActiveWatchesForMessage: () => Effect.void,
    listActiveByWatchedThread: () => Effect.succeed([]),
    listActiveByWatcherAndMessage: () => Effect.succeed([]),
    listActiveByWatcher: () => Effect.succeed([]),
    markGroupTriggered: () => Effect.succeed(false),
    cancelActiveForWatcher: () => Effect.void,
    listAllActive: () => Effect.succeed([]),
  };
  const repository: ThreadDelegationRepositoryShape = {
    getByInvocation: (input) => getByInvocation(input),
    reserve: (_input) => Effect.succeed(delegation),
    updateState,
    storeResult,
    findDirectByChild: () => Effect.succeed(Option.none()),
  };
  return {
    engine,
    dispatch,
    repository,
    projectionThreadWatchRepository,
    addActiveWatch,
    updateState,
    storeResult,
    delegation,
    setGetByInvocation: (value: ThreadDelegationRepositoryShape["getByInvocation"]) => {
      getByInvocation = value;
    },
  };
}
