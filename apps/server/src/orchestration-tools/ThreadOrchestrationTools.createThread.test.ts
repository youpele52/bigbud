import { MessageId, ProjectId, ThreadId, TurnId } from "@bigbud/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import { createThreadViaOrchestration } from "./ThreadOrchestrationTools.ts";
import type { ThreadDelegationRepositoryShape } from "../persistence/Services/ThreadDelegations.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionThreadWatchRepositoryShape } from "../persistence/Services/ProjectionThreadWatches.ts";
import type { PersistenceSqlError } from "../persistence/Errors.ts";

const callerThreadId = ThreadId.makeUnsafe("caller-thread");
const callerProjectId = ProjectId.makeUnsafe("caller-project");
const targetProjectId = ProjectId.makeUnsafe("target-project");
const sourceMessageId = MessageId.makeUnsafe("source-message");

const callerThread = {
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

function makeSystem() {
  const dispatch = vi.fn((_command: unknown) => Effect.succeed({ sequence: 1 }));
  const engine = {
    getReadModel: () =>
      Effect.succeed({
        projects: [
          { id: callerProjectId, deletedAt: null, deletingAt: null },
          { id: targetProjectId, deletedAt: null, deletingAt: null },
        ],
        threads: [callerThread],
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  let getByInvocation: ThreadDelegationRepositoryShape["getByInvocation"] = () =>
    Effect.succeed(Option.none());
  const addActiveWatch = vi.fn(
    (_input: unknown): Effect.Effect<void, PersistenceSqlError> => Effect.void,
  );
  const updateState = vi.fn(() => Effect.void);
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
    storeResult: () => Effect.void,
    findDirectByChild: () => Effect.succeed(Option.none()),
  };
  return {
    engine,
    dispatch,
    repository,
    projectionThreadWatchRepository,
    addActiveWatch,
    updateState,
    delegation,
    setGetByInvocation: (value: ThreadDelegationRepositoryShape["getByInvocation"]) => {
      getByInvocation = value;
    },
  };
}

const run = (input: Parameters<typeof createThreadViaOrchestration>[0]) =>
  Effect.runPromise(createThreadViaOrchestration(input));

describe("createThreadViaOrchestration", () => {
  it("creates a child in the caller's project by default", async () => {
    const system = makeSystem();
    await run({
      orchestrationEngine: system.engine,
      threadDelegationRepository: system.repository,
      projectionThreadWatchRepository: system.projectionThreadWatchRepository,
      callerThreadId,
      sourceMessageId,
      invocationId: "invocation-1",
      title: " Child ",
      task: "Do the work",
      watchForCompletion: false,
    });
    expect(system.dispatch).toHaveBeenCalledTimes(2);
    expect(system.dispatch.mock.calls[0]?.[0]).toMatchObject({
      type: "thread.create",
      projectId: callerProjectId,
      purpose: "standard",
    });
    expect(system.dispatch.mock.calls[1]?.[0]).toMatchObject({
      type: "thread.turn.start",
      message: { text: expect.stringContaining("delegated standalone thread") },
    });
  });

  it("accepts an existing target project", async () => {
    const system = makeSystem();
    await run({
      orchestrationEngine: system.engine,
      threadDelegationRepository: system.repository,
      projectionThreadWatchRepository: system.projectionThreadWatchRepository,
      callerThreadId,
      sourceMessageId,
      invocationId: "invocation-2",
      title: "Child",
      task: "Do the work",
      projectId: targetProjectId,
      watchForCompletion: true,
    });
    expect(system.dispatch.mock.calls[0]?.[0]).toMatchObject({ projectId: targetProjectId });
    expect(system.addActiveWatch).toHaveBeenCalledWith(
      expect.objectContaining({
        watcherThreadId: callerThreadId,
        watchedThreadId: system.delegation.childThreadId,
        sourceMessageId,
      }),
    );
  });

  it("replays an existing delegation without dispatching commands", async () => {
    const system = makeSystem();
    const replay = { ...system.delegation, state: "completed" as const };
    system.setGetByInvocation(() => Effect.succeed(Option.some(replay)));
    const result = await run({
      orchestrationEngine: system.engine,
      threadDelegationRepository: system.repository,
      projectionThreadWatchRepository: system.projectionThreadWatchRepository,
      callerThreadId,
      sourceMessageId,
      invocationId: "invocation-1",
      title: "Child",
      task: "Do the work",
      watchForCompletion: false,
    });
    expect(result.replayed).toBe(true);
    expect(system.dispatch).not.toHaveBeenCalled();
  });

  it("replays a watch-armed delegation without dispatching or re-arming", async () => {
    const system = makeSystem();
    system.setGetByInvocation(() =>
      Effect.succeed(Option.some({ ...system.delegation, state: "watch_armed" as const })),
    );
    const result = await run({
      orchestrationEngine: system.engine,
      threadDelegationRepository: system.repository,
      projectionThreadWatchRepository: system.projectionThreadWatchRepository,
      callerThreadId,
      sourceMessageId,
      invocationId: "invocation-1",
      title: "Child",
      task: "Do the work",
      watchForCompletion: true,
    });
    expect(result.replayed).toBe(true);
    expect(system.addActiveWatch).not.toHaveBeenCalled();
    expect(system.dispatch).not.toHaveBeenCalled();
  });

  it("marks the delegation failed when arming the watch fails", async () => {
    const system = makeSystem();
    system.addActiveWatch.mockImplementation(() =>
      Effect.fail(new Error("watch insert failed") as unknown as PersistenceSqlError),
    );
    await expect(
      run({
        orchestrationEngine: system.engine,
        threadDelegationRepository: system.repository,
        projectionThreadWatchRepository: system.projectionThreadWatchRepository,
        callerThreadId,
        sourceMessageId,
        invocationId: "invocation-1",
        title: "Child",
        task: "Do the work",
        watchForCompletion: true,
      }),
    ).rejects.toThrow("watch insert failed");
    expect(system.updateState).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: "failed" }),
    );
  });

  it("rejects empty and oversized input", async () => {
    const system = makeSystem();
    await expect(
      run({
        orchestrationEngine: system.engine,
        threadDelegationRepository: system.repository,
        projectionThreadWatchRepository: system.projectionThreadWatchRepository,
        callerThreadId,
        sourceMessageId,
        invocationId: "invocation-1",
        title: "",
        task: "Do the work",
        watchForCompletion: false,
      }),
    ).rejects.toThrow("title");
    await expect(
      run({
        orchestrationEngine: system.engine,
        threadDelegationRepository: system.repository,
        projectionThreadWatchRepository: system.projectionThreadWatchRepository,
        callerThreadId,
        sourceMessageId,
        invocationId: "invocation-1",
        title: "Child",
        task: "x".repeat(32_001),
        watchForCompletion: false,
      }),
    ).rejects.toThrow("32000");
  });
});
