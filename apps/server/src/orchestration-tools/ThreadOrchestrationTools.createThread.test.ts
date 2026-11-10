import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import { createThreadViaOrchestration } from "./ThreadOrchestrationTools.createThread.ts";
import type { PersistenceSqlError } from "../persistence/Errors.ts";
import {
  callerProjectId,
  callerThread,
  callerThreadId,
  makeSystem,
  sourceMessageId,
  targetProjectId,
} from "./ThreadOrchestrationTools.createThread.test.helpers.ts";
import {
  makeTestCoordination,
  messageEvent,
  pushClientAnswer,
  threadAttachment,
  turnStartEvent,
} from "./ThreadCoordinationConfirmation.test.helpers.ts";

const run = (input: Parameters<typeof createThreadViaOrchestration>[0]) =>
  Effect.runPromise(createThreadViaOrchestration(input));

describe("createThreadViaOrchestration", () => {
  it("rejects delegation from a removed provider without dispatching or reserving a child", async () => {
    const system = makeSystem({
      ...callerThread,
      modelSelection: { provider: "kilocode", model: "legacy-model" },
    });
    const reserve = vi.spyOn(system.repository, "reserve");
    await expect(
      run({
        orchestrationEngine: system.engine,
        threadDelegationRepository: system.repository,
        projectionThreadWatchRepository: system.projectionThreadWatchRepository,
        callerThreadId,
        sourceMessageId,
        invocationId: "removed-provider",
        title: "Child",
        task: "Do the work",
        watchForCompletion: false,
      }),
    ).rejects.toThrow("provider is no longer available");
    expect(system.dispatch).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(system.updateState).not.toHaveBeenCalled();
  });
  it("preserves V2 identity/supervised targets for canonical background children and cached delegation never dispatches again", async () => {
    const modelSelection = {
      provider: "opencodeV2",
      model: "synthetic-model",
      subProviderID: "synthetic-provider",
    };
    const system = makeSystem({
      ...callerThread,
      modelSelection,
      runtimeMode: "approval-required",
      providerRuntimeExecutionTargetId: "local",
      workspaceExecutionTargetId: "local",
      executionTargetId: "local",
    });
    const input = {
      orchestrationEngine: system.engine,
      threadDelegationRepository: system.repository,
      projectionThreadWatchRepository: system.projectionThreadWatchRepository,
      callerThreadId,
      sourceMessageId,
      invocationId: "v2-tool:stable-native-call",
      title: "V2 background child",
      task: "Actual independent canonical work",
      watchForCompletion: true,
    };
    await run(input);
    expect(system.dispatch.mock.calls[0]?.[0]).toMatchObject({
      type: "thread.create",
      modelSelection,
      runtimeMode: "approval-required",
      providerRuntimeExecutionTargetId: "local",
      workspaceExecutionTargetId: "local",
    });
    expect(system.dispatch.mock.calls[2]?.[0]).toMatchObject({
      type: "thread.turn.start",
      threadId: system.delegation.childThreadId,
      modelSelection,
    });
    expect(system.addActiveWatch).toHaveBeenCalledWith(
      expect.objectContaining({
        watcherThreadId: callerThreadId,
        watchedThreadId: system.delegation.childThreadId,
        sourceMessageId,
      }),
    );
    system.setGetByInvocation(() =>
      Effect.succeed(Option.some({ ...system.delegation, state: "completed" as const })),
    );
    await run(input);
    expect(system.dispatch).toHaveBeenCalledTimes(3);
  });
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
    expect(system.dispatch).toHaveBeenCalledTimes(3);
    expect(system.dispatch.mock.calls[0]?.[0]).toMatchObject({
      type: "thread.create",
      projectId: callerProjectId,
      purpose: "standard",
      providerRuntimeExecutionTargetId: "provider-target",
      workspaceExecutionTargetId: "workspace-target",
      executionTargetId: "execution-target",
    });
    expect(system.dispatch.mock.calls[1]?.[0]).toMatchObject({
      type: "thread.activity.append",
      threadId: callerThreadId,
      activity: {
        kind: "delegation.child-linked",
        payload: { childProjectId: callerProjectId, childTitle: "Child" },
      },
    });
    expect(system.dispatch.mock.calls[2]?.[0]).toMatchObject({
      type: "thread.turn.start",
      message: { text: expect.stringContaining("delegated standalone thread") },
    });
  });

  it("asks before creating in another project, reserving nothing until the user allows", async () => {
    const system = makeSystem();
    const reserve = vi.spyOn(system.repository, "reserve");
    const { coordination, log } = makeTestCoordination();
    const create = () =>
      run({
        orchestrationEngine: system.engine,
        threadDelegationRepository: system.repository,
        projectionThreadWatchRepository: system.projectionThreadWatchRepository,
        coordination,
        callerThreadId,
        sourceMessageId,
        invocationId: "invocation-2",
        title: "Child",
        task: "Do the work",
        projectId: targetProjectId,
        watchForCompletion: true,
      });
    const challenge = await create();
    if (!("status" in challenge) || challenge.status !== "confirmation_required") {
      throw new Error("expected a confirmation challenge");
    }
    expect(challenge).toMatchObject({ targetProjectId, targetProjectTitle: "Target project" });
    expect(reserve).not.toHaveBeenCalled();
    expect(system.dispatch).not.toHaveBeenCalled();
    pushClientAnswer(log, { callerThreadId, question: challenge.question, answer: "Allow" });
    await expect(create()).resolves.toMatchObject({ accepted: true, replayed: false });
    expect(reserve).toHaveBeenCalledTimes(1);
    const createCommand = system.dispatch.mock.calls[0]?.[0];
    expect(createCommand).toMatchObject({ projectId: targetProjectId });
    expect(createCommand).not.toHaveProperty("providerRuntimeExecutionTargetId");
    expect(createCommand).not.toHaveProperty("workspaceExecutionTargetId");
    expect(createCommand).not.toHaveProperty("executionTargetId");
    expect(system.addActiveWatch).toHaveBeenCalledWith(
      expect.objectContaining({
        watcherThreadId: callerThreadId,
        watchedThreadId: system.delegation.childThreadId,
        sourceMessageId,
      }),
    );
  });

  it.each([
    ["a thread in that project attached", "thread-in-target", "accepted"],
    ["nothing attached", null, "confirmation_required"],
    ["only a thread from another project attached", "thread-elsewhere", "confirmation_required"],
  ] as const)(
    "creates in another project on the user's request with %s: %s",
    async (_name, attached, expected) => {
      const system = makeSystem();
      const readModel = Effect.runSync(system.engine.getReadModel());
      const engine = {
        ...system.engine,
        getReadModel: () =>
          Effect.succeed({
            ...readModel,
            threads: [
              ...readModel.threads,
              { id: "thread-in-target", projectId: targetProjectId, deletedAt: null },
              { id: "thread-elsewhere", projectId: callerProjectId, deletedAt: null },
            ],
          }),
      } as typeof system.engine;
      const { coordination, grants, log } = makeTestCoordination();
      log.push(
        messageEvent({
          threadId: callerThreadId,
          sequence: 1,
          text: "start a chat in the attached thread's project",
          attachments: attached ? [threadAttachment(attached)] : [],
          commandId: "client-submit-1",
        }),
        turnStartEvent({
          threadId: callerThreadId,
          sequence: 2,
          messageId: "message-1",
          commandId: "client-submit-1",
        }),
      );
      const result = await run({
        orchestrationEngine: engine,
        threadDelegationRepository: system.repository,
        projectionThreadWatchRepository: system.projectionThreadWatchRepository,
        coordination,
        callerThreadId,
        sourceMessageId,
        invocationId: "invocation-implicit",
        title: "Child",
        task: "Do the work",
        projectId: targetProjectId,
        watchForCompletion: false,
      });
      if (expected === "accepted") {
        expect(result).toMatchObject({ accepted: true, replayed: false });
        expect(await Effect.runPromise(grants.hasGrant(callerThreadId, targetProjectId))).toBe(
          false,
        );
      } else {
        expect(result).toMatchObject({ status: "confirmation_required" });
        expect(system.dispatch).not.toHaveBeenCalled();
      }
    },
  );

  it("replays an existing delegation, even into another project, with no confirmation", async () => {
    const system = makeSystem();
    const replay = { ...system.delegation, targetProjectId, state: "completed" as const };
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
      // A restart lost every grant; replay must still not ask again.
      projectId: targetProjectId,
      watchForCompletion: false,
    });
    expect(result).toMatchObject({ replayed: true });
    expect(system.dispatch).not.toHaveBeenCalled();
  });

  it("refuses a replayed invocation that names a different project, before any gate", async () => {
    const system = makeSystem();
    const reserve = vi.spyOn(system.repository, "reserve");
    // The stored delegation targets the caller's project; the retry names another project.
    system.setGetByInvocation(() =>
      Effect.succeed(Option.some({ ...system.delegation, state: "completed" as const })),
    );
    const { coordination, grants } = makeTestCoordination();
    await Effect.runPromise(grants.grant(callerThreadId, targetProjectId));
    await expect(
      run({
        orchestrationEngine: system.engine,
        threadDelegationRepository: system.repository,
        projectionThreadWatchRepository: system.projectionThreadWatchRepository,
        coordination,
        callerThreadId,
        sourceMessageId,
        invocationId: "invocation-1",
        title: "Child",
        task: "Do the work",
        projectId: targetProjectId,
        watchForCompletion: false,
      }),
    ).rejects.toThrow("already targets a different project");
    expect(reserve).not.toHaveBeenCalled();
    expect(system.dispatch).not.toHaveBeenCalled();
    expect(system.updateState).not.toHaveBeenCalled();
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
    expect(result).toMatchObject({ replayed: true });
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
