import { CommandId, ProjectId, ThreadId } from "@bigbud/contracts";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";

import { ensureOrchestrationWorkspaceProjects } from "../Services/OrchestrationEngine.ts";
import {
  createCommands,
  createRuntime,
  engineFor,
  withDatabase,
} from "./OrchestrationEngine.test.runtime.ts";

const projectId = ProjectId.makeUnsafe("idle-project");
const settledThread = ThreadId.makeUnsafe("idle-settled-thread");
const createdAt = "2026-11-18T00:00:00.000Z";

/**
 * F-P8-2: after a restart the startup window holds only projects with an operational thread, so
 * an idle project (only settled threads) is absent until a command references it. Each case runs
 * on a fresh engine over the same database.
 */
describe("OrchestrationEngine idle project after restart", () => {
  const seed = async (dbPath: string) => {
    const [projectCreate, threadCreate] = createCommands(projectId, [settledThread]);
    const workspaceRoot = dirname(dbPath);
    const first = createRuntime(dbPath);
    const engine = await engineFor(first);
    await first.runPromise(engine.dispatch({ ...projectCreate!, workspaceRoot } as never));
    await first.runPromise(engine.dispatch(threadCreate!));
    await first.dispose();
    return workspaceRoot;
  };

  const restarted = async (dbPath: string) => {
    const runtime = createRuntime(dbPath);
    const engine = await engineFor(runtime);
    const model = await runtime.runPromise(engine.getReadModel());
    // Precondition of the defect: the idle project is not in the startup read model.
    expect(model.projects.map((project) => project.id)).not.toContain(projectId);
    return { runtime, engine };
  };

  it("creates a thread in a project that has only settled threads", () =>
    withDatabase("bigbud-idle-project-thread-", async (dbPath) => {
      await seed(dbPath);
      const { runtime, engine } = await restarted(dbPath);
      await runtime.runPromise(
        engine.dispatch({
          ...createCommands(projectId, [ThreadId.makeUnsafe("idle-new-thread")])[1]!,
          createdAt,
        } as never),
      );
      const model = await runtime.runPromise(engine.getReadModel());
      expect(model.projects.map((project) => project.id)).toContain(projectId);
      expect(model.threads.map((thread) => thread.id)).toContain("idle-new-thread");
      await runtime.dispose();
    }));

  it("finds the idle project by workspace root and keeps the root unique", () =>
    withDatabase("bigbud-idle-project-root-", async (dbPath) => {
      const workspaceRoot = await seed(dbPath);
      const { runtime, engine } = await restarted(dbPath);
      const found = await runtime.runPromise(
        ensureOrchestrationWorkspaceProjects(engine, workspaceRoot),
      );
      expect(found.map((project) => project.id)).toEqual([projectId]);

      const second = createRuntime(dbPath);
      await runtime.dispose();
      const secondEngine = await engineFor(second);
      await expect(
        second.runPromise(
          secondEngine.dispatch({
            type: "project.create",
            commandId: CommandId.makeUnsafe("duplicate-root"),
            projectId: ProjectId.makeUnsafe("duplicate-root-project"),
            title: "Duplicate",
            workspaceRoot,
            createdAt,
          }),
        ),
      ).rejects.toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
      await second.runPromise(
        secondEngine.dispatch({
          type: "project.meta.update",
          commandId: CommandId.makeUnsafe("idle-rename"),
          projectId,
          title: "Renamed after restart",
        }),
      );
      const model = await second.runPromise(secondEngine.getReadModel());
      expect(model.projects.find((project) => project.id === projectId)?.title).toBe(
        "Renamed after restart",
      );
      await second.dispose();
    }));

  it("deletes an idle project with a cascade over its settled threads", () =>
    withDatabase("bigbud-idle-project-delete-", async (dbPath) => {
      await seed(dbPath);
      const { runtime, engine } = await restarted(dbPath);
      const accepted = await runtime.runPromise(
        engine.dispatch({
          type: "project.delete",
          commandId: CommandId.makeUnsafe("idle-delete"),
          projectId,
        }),
      );
      const replay = await runtime.runPromise(engine.readReplay(accepted.sequence - 2));
      const types = replay.events
        .filter((event) => event.commandId === "idle-delete")
        .map((event) => [event.type, event.aggregateId]);
      expect(types).toEqual([
        ["thread.deletion-requested", settledThread],
        ["project.deletion-requested", projectId],
      ]);
      await runtime.dispose();
    }));
});
