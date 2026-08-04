import { CommandId, DEFAULT_PROVIDER_INTERACTION_MODE, ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { asProjectId, createOrchestrationSystem, now } from "./OrchestrationEngine.test.helpers.ts";

const modelSelection = { provider: "codex" as const, model: "gpt-5-codex" };

describe("OrchestrationEngine deletion lifecycle invariants", () => {
  it("rejects commands under a deleted project and allows explicit project resurrection", async () => {
    const system = await createOrchestrationSystem();
    const projectId = asProjectId("deleted-project");
    const createdAt = now();
    await system.run(
      system.engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("create-deleted-project"),
        projectId,
        title: "Deleted",
        workspaceRoot: "/tmp/deleted-project",
        defaultModelSelection: modelSelection,
        createdAt,
      }),
    );
    await system.run(
      system.engine.dispatch({
        type: "project.delete",
        commandId: CommandId.makeUnsafe("delete-project"),
        projectId,
      }),
    );
    await system.run(
      system.engine.dispatch({
        type: "project.delete.finalize",
        commandId: CommandId.makeUnsafe("finalize-project"),
        projectId,
        createdAt,
      }),
    );

    await expect(
      system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("create-under-deleted-project"),
          threadId: ThreadId.makeUnsafe("blocked-thread"),
          projectId,
          title: "Blocked",
          modelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("already been deleted");
    await expect(
      system.run(
        system.engine.dispatch({
          type: "project.delete",
          commandId: CommandId.makeUnsafe("duplicate-project-delete"),
          projectId,
        }),
      ),
    ).rejects.toThrow("already been deleted");

    await system.run(
      system.engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("resurrect-project"),
        projectId,
        title: "Resurrected",
        workspaceRoot: "/tmp/deleted-project",
        defaultModelSelection: modelSelection,
        createdAt,
      }),
    );
    expect(
      (await system.run(system.engine.getReadModel())).projects.find(
        (project) => project.id === projectId,
      ),
    ).toMatchObject({ title: "Resurrected", deletedAt: null });
    await system.dispose();
  });

  it("guards deleted thread controls and allows explicit thread resurrection", async () => {
    const system = await createOrchestrationSystem();
    const projectId = asProjectId("thread-resurrection-project");
    const threadId = ThreadId.makeUnsafe("deleted-thread");
    const createdAt = now();
    await system.run(
      system.engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("create-thread-project"),
        projectId,
        title: "Project",
        workspaceRoot: "/tmp/thread-resurrection",
        defaultModelSelection: modelSelection,
        createdAt,
      }),
    );
    const createThread = (commandId: string) =>
      system.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe(commandId),
        threadId,
        projectId,
        title: commandId,
        modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      });
    await system.run(createThread("create-thread"));
    await system.run(
      system.engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.makeUnsafe("delete-thread"),
        threadId,
      }),
    );
    await system.run(
      system.engine.dispatch({
        type: "thread.delete.finalize",
        commandId: CommandId.makeUnsafe("finalize-thread"),
        threadId,
        createdAt,
      }),
    );

    for (const command of [
      { type: "thread.delete" as const, commandId: "duplicate-thread-delete" },
      { type: "thread.turn.interrupt" as const, commandId: "interrupt-deleted-thread" },
      { type: "thread.session.stop" as const, commandId: "stop-deleted-thread" },
    ]) {
      const dispatched =
        command.type === "thread.delete"
          ? system.engine.dispatch({
              type: command.type,
              commandId: CommandId.makeUnsafe(command.commandId),
              threadId,
            })
          : system.engine.dispatch({
              type: command.type,
              commandId: CommandId.makeUnsafe(command.commandId),
              threadId,
              createdAt,
            });
      await expect(system.run(dispatched)).rejects.toThrow("already been deleted");
    }

    await system.run(createThread("resurrect-thread"));
    expect(
      (await system.run(system.engine.getReadModel())).threads.find(
        (thread) => thread.id === threadId,
      ),
    ).toMatchObject({ title: "resurrect-thread", deletedAt: null });
    await system.dispose();
  });
});
