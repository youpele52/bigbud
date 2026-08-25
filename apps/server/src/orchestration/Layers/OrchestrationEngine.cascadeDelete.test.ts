import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ThreadId,
  type OrchestrationEvent,
} from "@bigbud/contracts";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { asProjectId, createOrchestrationSystem, now } from "./OrchestrationEngine.test.helpers.ts";

describe("OrchestrationEngine", () => {
  it("requests deletion for each project root subtree before deleting the project", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-cascade-create"),
        projectId: asProjectId("project-cascade"),
        title: "Cascade Project",
        workspaceRoot: "/tmp/project-cascade",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-cascade-1-create"),
        threadId: ThreadId.makeUnsafe("thread-cascade-1"),
        projectId: asProjectId("project-cascade"),
        title: "Cascade Thread 1",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-cascade-2-create"),
        threadId: ThreadId.makeUnsafe("thread-cascade-2"),
        projectId: asProjectId("project-cascade"),
        title: "Cascade Thread 2",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        parentThread: {
          threadId: ThreadId.makeUnsafe("thread-cascade-1"),
          projectId: asProjectId("project-cascade"),
          title: "Cascade Thread 1",
        },
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.makeUnsafe("cmd-thread-cascade-single-delete"),
        threadId: ThreadId.makeUnsafe("thread-cascade-1"),
      }),
    );
    expect(
      await system.run(
        engine.threadDeletion!.isFenceRoot(ThreadId.makeUnsafe("thread-cascade-1"), "subtree"),
      ),
    ).toBe(false);

    await system.run(
      engine.dispatch({
        type: "project.delete",
        commandId: CommandId.makeUnsafe("cmd-project-cascade-delete"),
        projectId: asProjectId("project-cascade"),
      }),
    );

    const events = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(events.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
      "thread.created",
      "thread.deletion-requested",
      "thread.deletion-requested",
      "thread.deletion-requested",
      "project.deletion-requested",
    ]);
    expect(
      events
        .filter((event) => event.type === "thread.deletion-requested")
        .map((event) => event.payload.mode),
    ).toEqual(["single", "subtree", "subtree"]);
    expect(
      await system.run(
        engine.threadDeletion!.isFenceRoot(ThreadId.makeUnsafe("thread-cascade-1"), "subtree"),
      ),
    ).toBe(true);
    expect(
      await system.run(
        engine.threadDeletion!.isFenced({
          threadId: ThreadId.makeUnsafe("thread-cascade-2"),
          readModel: await system.run(engine.getReadModel()),
        }),
      ),
    ).toBe(true);
    await system.run(
      engine.threadDeletion!.releaseFence(ThreadId.makeUnsafe("thread-cascade-1"), "subtree"),
    );
    expect(
      await system.run(
        engine.threadDeletion!.isFenced({
          threadId: ThreadId.makeUnsafe("thread-cascade-2"),
          readModel: await system.run(engine.getReadModel()),
        }),
      ),
    ).toBe(true);

    const readModel = await system.run(engine.getReadModel());
    expect(
      readModel.projects.find((project) => project.id === asProjectId("project-cascade"))
        ?.deletingAt,
    ).not.toBeNull();
    expect(
      readModel.projects.find((project) => project.id === asProjectId("project-cascade"))
        ?.deletedAt,
    ).toBeNull();
    expect(
      readModel.threads.find((thread) => thread.id === ThreadId.makeUnsafe("thread-cascade-1"))
        ?.deletingAt,
    ).not.toBeNull();
    expect(
      readModel.threads.find((thread) => thread.id === ThreadId.makeUnsafe("thread-cascade-2"))
        ?.deletingAt,
    ).not.toBeNull();

    await system.dispose();
  });
});
