import { CommandId, DEFAULT_PROVIDER_INTERACTION_MODE, ThreadId } from "@bigbud/contracts";
import { Stream } from "effect";
import { describe, expect, it } from "vitest";

import { asProjectId, createOrchestrationSystem, now } from "./OrchestrationEngine.test.helpers.ts";

describe("OrchestrationEngine project reconfiguration", () => {
  it("reconfigures a project and its threads atomically", async () => {
    const system = await createOrchestrationSystem();
    const createdAt = now();
    const projectId = asProjectId("project-reconfigure");
    const threadId = ThreadId.makeUnsafe("thread-reconfigure");

    await system.run(
      system.engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-reconfigure-create"),
        projectId,
        title: "Local Project",
        workspaceRoot: "/tmp/local-project",
        defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
        createdAt,
      }),
    );
    await system.run(
      system.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-project-reconfigure-thread"),
        threadId,
        projectId,
        title: "Thread",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      system.engine.dispatch({
        type: "project.reconfigure",
        commandId: CommandId.makeUnsafe("cmd-project-reconfigure"),
        projectId,
        title: "Remote Project",
        providerRuntimeExecutionTargetId: "ssh:devbox",
        workspaceExecutionTargetId: "ssh:devbox",
        executionTargetId: "ssh:devbox",
        workspaceRoot: "~/workspace/project",
        expectedUpdatedAt: createdAt,
        verifiedWorktreePaths: [],
      }),
    );

    const readModel = await system.run(system.engine.getReadModel());
    expect(readModel.projects.find((project) => project.id === projectId)).toMatchObject({
      title: "Remote Project",
      providerRuntimeExecutionTargetId: "ssh:devbox",
      workspaceExecutionTargetId: "ssh:devbox",
      workspaceRoot: "~/workspace/project",
    });
    expect(readModel.threads.find((thread) => thread.id === threadId)).toMatchObject({
      providerRuntimeExecutionTargetId: "ssh:devbox",
      workspaceExecutionTargetId: "ssh:devbox",
    });

    const events = await system.run(system.engine.readEvents(0).pipe(Stream.runCollect));
    expect(
      Array.from(events)
        .slice(-2)
        .map((event) => event.type),
    ).toEqual(["project.meta-updated", "thread.meta-updated"]);
    await system.dispose();
  });

  it("rejects reconfiguration when a project thread has an active turn", async () => {
    const system = await createOrchestrationSystem();
    const createdAt = now();
    const projectId = asProjectId("project-reconfigure-active");
    const threadId = ThreadId.makeUnsafe("thread-reconfigure-active");

    await system.run(
      system.engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-reconfigure-active-create"),
        projectId,
        title: "Project",
        workspaceRoot: "/tmp/project-reconfigure-active",
        defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
        createdAt,
      }),
    );
    await system.run(
      system.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-project-reconfigure-active-thread"),
        threadId,
        projectId,
        title: "Thread",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      system.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-project-reconfigure-active-session"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: "turn-reconfigure-active" as never,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await expect(
      system.run(
        system.engine.dispatch({
          type: "project.reconfigure",
          commandId: CommandId.makeUnsafe("cmd-project-reconfigure-active"),
          projectId,
          title: "Remote Project",
          providerRuntimeExecutionTargetId: "ssh:devbox",
          workspaceExecutionTargetId: "ssh:devbox",
          executionTargetId: "ssh:devbox",
          workspaceRoot: "~/workspace/project",
          expectedUpdatedAt: createdAt,
          verifiedWorktreePaths: [],
        }),
      ),
    ).rejects.toThrow("active turn or session");
    await system.dispose();
  });

  it("rejects stale project reconfiguration", async () => {
    const system = await createOrchestrationSystem();
    const createdAt = now();
    const projectId = asProjectId("project-reconfigure-stale");
    await system.run(
      system.engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-reconfigure-stale-create"),
        projectId,
        title: "Project",
        workspaceRoot: "/tmp/project-reconfigure-stale",
        defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
        createdAt,
      }),
    );
    await system.run(
      system.engine.dispatch({
        type: "project.meta.update",
        commandId: CommandId.makeUnsafe("cmd-project-reconfigure-stale-rename"),
        projectId,
        title: "Renamed",
      }),
    );

    await expect(
      system.run(
        system.engine.dispatch({
          type: "project.reconfigure",
          commandId: CommandId.makeUnsafe("cmd-project-reconfigure-stale"),
          projectId,
          title: "Remote Project",
          providerRuntimeExecutionTargetId: "ssh:devbox",
          workspaceExecutionTargetId: "ssh:devbox",
          executionTargetId: "ssh:devbox",
          workspaceRoot: "~/workspace/project",
          expectedUpdatedAt: createdAt,
          verifiedWorktreePaths: [],
        }),
      ),
    ).rejects.toThrow("changed after editing started");
    await system.dispose();
  });
});
