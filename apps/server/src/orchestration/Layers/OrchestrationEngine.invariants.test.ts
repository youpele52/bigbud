import { CommandId, DEFAULT_PROVIDER_INTERACTION_MODE, ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  asMessageId,
  asProjectId,
  createOrchestrationSystem,
  now,
} from "./OrchestrationEngine.test.helpers.ts";

describe("OrchestrationEngine", () => {
  it("fails command dispatch when command invariants are violated", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-invariant-missing-thread"),
          threadId: ThreadId.makeUnsafe("thread-missing"),
          message: {
            messageId: asMessageId("msg-missing"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now(),
        }),
      ),
    ).rejects.toThrow("Thread 'thread-missing' does not exist");

    await system.dispose();
  });

  it("rejects duplicate thread creation", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-duplicate-create"),
        projectId: asProjectId("project-duplicate"),
        title: "Duplicate Project",
        workspaceRoot: "/tmp/project-duplicate",
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
        commandId: CommandId.makeUnsafe("cmd-thread-duplicate-1"),
        threadId: ThreadId.makeUnsafe("thread-duplicate"),
        projectId: asProjectId("project-duplicate"),
        title: "duplicate",
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

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-thread-duplicate-2"),
          threadId: ThreadId.makeUnsafe("thread-duplicate"),
          projectId: asProjectId("project-duplicate"),
          title: "duplicate",
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
      ),
    ).rejects.toThrow("already exists");

    await system.dispose();
  });

  it("allows a thread to reference an existing parent in another project", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    for (const [projectId, threadId] of [
      ["project-parent", "thread-parent"],
      ["project-child", "thread-child"],
    ] as const) {
      await system.run(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe(`cmd-${projectId}`),
          projectId: asProjectId(projectId),
          title: projectId,
          workspaceRoot: `/tmp/${projectId}`,
          defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
          createdAt,
        }),
      );
      if (projectId === "project-parent") {
        await system.run(
          engine.dispatch({
            type: "thread.create",
            commandId: CommandId.makeUnsafe("cmd-thread-parent"),
            threadId: ThreadId.makeUnsafe(threadId),
            projectId: asProjectId(projectId),
            title: "parent",
            modelSelection: { provider: "codex", model: "gpt-5-codex" },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            branch: null,
            worktreePath: null,
            createdAt,
          }),
        );
      }
    }

    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-child"),
        threadId: ThreadId.makeUnsafe("thread-child"),
        projectId: asProjectId("project-child"),
        title: "child",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        parentThread: {
          threadId: ThreadId.makeUnsafe("thread-parent"),
          title: "parent",
          projectId: asProjectId("project-parent"),
        },
        createdAt,
      }),
    );

    const readModel = await system.run(engine.getReadModel());
    expect(readModel.threads.find((thread) => thread.id === "thread-child")?.parentThread).toEqual({
      threadId: "thread-parent",
      title: "parent",
      projectId: "project-parent",
    });
    await system.dispose();
  });
});
