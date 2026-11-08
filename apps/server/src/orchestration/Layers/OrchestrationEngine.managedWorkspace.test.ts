import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import {
  CommandId,
  ThreadId,
  RuntimeTaskId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type OrchestrationCommand,
} from "@bigbud/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { asProjectId, createOrchestrationSystem, now } from "./OrchestrationEngine.test.helpers.ts";

type WithoutCommandId<T> = T extends unknown ? Omit<T, "commandId"> : never;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).toReversed()) await dispose();
});
async function fixture() {
  const system = await createOrchestrationSystem();
  cleanup.push(system.dispose);
  const destination = await fs.mkdtemp(path.join(tmpdir(), "bigbud-project-attach-"));
  cleanup.push(() => fs.rm(destination, { recursive: true, force: true }));
  const projectId = asProjectId("managed-project");
  let id = 0;
  const dispatch = (command: WithoutCommandId<OrchestrationCommand>) =>
    system.run(
      system.engine.dispatch({
        ...command,
        commandId: CommandId.makeUnsafe(`managed-${++id}`),
      } as OrchestrationCommand),
    );
  const create = {
    type: "project.create" as const,
    commandId: CommandId.makeUnsafe("managed-create"),
    projectId,
    title: "Name only",
    workspaceRoot: null,
    createdAt: now(),
  };
  await system.run(system.engine.dispatch(create));
  const read = () => system.run(system.engine.getReadModel());
  const project = (await read()).projects.find((entry) => entry.id === projectId)!;
  cleanup.push(() => fs.rm(project.workspaceRoot!, { recursive: true, force: true }));
  const reconfigure = (action?: "switch" | "transfer") =>
    system.run(
      system.engine.dispatch({
        type: "project.reconfigure",
        commandId: CommandId.makeUnsafe(`attach-${++id}`),
        projectId,
        title: "Edited",
        providerRuntimeExecutionTargetId: "local",
        workspaceExecutionTargetId: "local",
        executionTargetId: "local",
        workspaceRoot: destination,
        expectedUpdatedAt: project.updatedAt,
        verifiedWorktreePaths: [],
        ...(action ? { workspaceAction: action } : {}),
      }),
    );
  return { ...system, destination, projectId, project, create, dispatch, read, reconfigure };
}

describe("managed project workspaces", () => {
  it("persists concrete ID-keyed storage without git, retries creation, and renames without relocation", async () => {
    const f = await fixture();
    expect(f.project.workspaceKind).toBe("managed");
    expect(await fs.readdir(f.project.workspaceRoot!)).toEqual([]);
    expect(f.project.workspaceRoot).not.toContain("Name only");
    await f.run(f.engine.dispatch(f.create));
    expect((await f.read()).projects.filter((entry) => entry.id === f.projectId)).toHaveLength(1);
    await f.dispatch({ type: "project.meta.update", projectId: f.projectId, title: "Renamed" });
    expect((await f.read()).projects.find((entry) => entry.id === f.projectId)).toMatchObject({
      id: f.projectId,
      title: "Renamed",
      workspaceKind: "managed",
      workspaceRoot: f.project.workspaceRoot,
    });
  });
  it("keeps explicit paths externally owned even inside the managed storage area", async () => {
    const f = await fixture();
    const explicit = path.join(f.project.workspaceRoot!, "explicit");
    await fs.mkdir(explicit);
    await f.dispatch({
      type: "project.create",
      projectId: asProjectId("explicit"),
      title: "Explicit",
      workspaceRoot: explicit,
      createdAt: now(),
    });
    const project = (await f.read()).projects.find((entry) => entry.id === "explicit")!;
    expect(project.workspaceKind ?? "external").toBe("external");
    expect(project.workspaceRoot).toBe(explicit);
  });
  it("attaches an empty managed workspace and retains the original location", async () => {
    const f = await fixture();
    await f.reconfigure();
    expect((await f.read()).projects.find((entry) => entry.id === f.projectId)).toMatchObject({
      id: f.projectId,
      workspaceRoot: f.destination,
      workspaceKind: "external",
      previousWorkspaceRoot: f.project.workspaceRoot,
    });
    const rows = await f.runSql(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql`SELECT workspace_kind, previous_workspace_root FROM projection_projects WHERE project_id = ${f.projectId}`;
      }),
    );
    expect(rows[0]).toMatchObject({
      workspace_kind: "external",
      previous_workspace_root: f.project.workspaceRoot,
    });
    expect(await fs.readdir(f.project.workspaceRoot!)).toEqual([]);
  });
  it.each(["missing", "file"] as const)(
    "rejects a %s switch destination before committing",
    async (kind) => {
      const f = await fixture();
      await fs.rmdir(f.destination);
      if (kind === "file") await fs.writeFile(f.destination, "not a directory");
      await expect(f.reconfigure("switch")).rejects.toThrow(
        kind === "file" ? "existing directory" : "ENOENT",
      );
      expect((await f.read()).projects.find((entry) => entry.id === f.projectId)).toMatchObject({
        workspaceRoot: f.project.workspaceRoot,
        workspaceKind: "managed",
        updatedAt: f.project.updatedAt,
      });
    },
  );
  it("keeps the original recovery location discoverable across later folder switches", async () => {
    const f = await fixture();
    await f.reconfigure();
    const second = await fs.mkdtemp(path.join(tmpdir(), "bigbud-second-folder-"));
    cleanup.push(() => fs.rm(second, { recursive: true, force: true }));
    const current = (await f.read()).projects.find((entry) => entry.id === f.projectId)!;
    await f.dispatch({
      type: "project.reconfigure",
      projectId: f.projectId,
      title: current.title,
      providerRuntimeExecutionTargetId: "local",
      workspaceExecutionTargetId: "local",
      executionTargetId: "local",
      workspaceRoot: second,
      expectedUpdatedAt: current.updatedAt,
      verifiedWorktreePaths: [],
    });
    expect(
      (await f.read()).projects.find((entry) => entry.id === f.projectId)?.previousWorkspaceRoot,
    ).toBe(f.project.workspaceRoot);
  });
  it("requires an explicit populated-workspace choice and switches without moving", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.project.workspaceRoot!, "keep"), "data");
    await expect(f.reconfigure()).rejects.toThrow("Choose Transfer files");
    expect((await f.read()).projects.find((entry) => entry.id === f.projectId)?.workspaceRoot).toBe(
      f.project.workspaceRoot,
    );
    await f.reconfigure("switch");
    expect(await fs.readdir(f.destination)).toEqual([]);
    expect(await fs.readFile(path.join(f.project.workspaceRoot!, "keep"), "utf8")).toBe("data");
  });
  it("transfers to an empty folder, retaining recovery data and project/thread identities", async () => {
    const f = await fixture();
    const threadId = ThreadId.makeUnsafe("preserved-thread");
    await f.dispatch({
      type: "thread.create",
      threadId,
      projectId: f.projectId,
      title: "History owner",
      modelSelection: { provider: "codex", model: "gpt-5-codex" },
      runtimeMode: "approval-required",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      createdAt: now(),
    });
    const before = (await f.read()).threads.find((entry) => entry.id === threadId)!;
    await fs.writeFile(path.join(f.project.workspaceRoot!, "keep"), "data");
    await f.reconfigure("transfer");
    expect(await fs.readFile(path.join(f.destination, "keep"), "utf8")).toBe("data");
    expect(await fs.readFile(path.join(f.project.workspaceRoot!, "keep"), "utf8")).toBe("data");
    const after = (await f.read()).threads.find((entry) => entry.id === threadId)!;
    expect(after.projectId).toBe(f.projectId);
    expect(after.messages).toEqual(before.messages);
    expect(after.id).toBe(before.id);
  });
  it("does not change metadata or originals on transfer collisions", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.project.workspaceRoot!, "keep"), "original");
    await fs.writeFile(path.join(f.destination, "keep"), "user data");
    await expect(f.reconfigure("transfer")).rejects.toThrow("destination must be empty");
    expect((await f.read()).projects.find((entry) => entry.id === f.projectId)?.workspaceRoot).toBe(
      f.project.workspaceRoot,
    );
    expect(await fs.readFile(path.join(f.destination, "keep"), "utf8")).toBe("user data");
  });
  it("retains both copies and reports recovery paths when persistence fails after transfer", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.project.workspaceRoot!, "keep"), "original");
    await f.runSql(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TRIGGER reject_workspace_change BEFORE UPDATE OF workspace_root ON projection_projects
        BEGIN SELECT RAISE(ABORT, 'injected persistence failure'); END`;
      }),
    );
    await expect(f.reconfigure("transfer")).rejects.toThrow("Could not confirm the folder change");
    expect((await f.read()).projects.find((entry) => entry.id === f.projectId)?.workspaceRoot).toBe(
      f.project.workspaceRoot,
    );
    for (const root of [f.project.workspaceRoot!, f.destination]) {
      expect(await fs.readFile(path.join(root, "keep"), "utf8")).toBe("original");
    }
  });
  it.each(["pending", "inProgress"] as const)(
    "blocks %s tasks and retains folder and data",
    async (status) => {
      const f = await fixture();
      const threadId = ThreadId.makeUnsafe("task-owner");
      const createdAt = now();
      await f.dispatch({
        type: "thread.create",
        threadId,
        projectId: f.projectId,
        title: "Task owner",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt,
      });
      await f.dispatch({
        type: "thread.task.upsert",
        threadId,
        createdAt,
        task: {
          id: RuntimeTaskId.makeUnsafe("busy-task"),
          subject: "Background work",
          status,
          source: "background",
          freshness: { sessionEpoch: "legacy", sourcePriority: 0, observedOrdinal: 1 },
          createdAt,
          updatedAt: createdAt,
        },
      });
      await expect(f.reconfigure("switch")).rejects.toThrow("unfinished tasks");
      expect(
        (await f.read()).projects.find((entry) => entry.id === f.projectId)?.workspaceRoot,
      ).toBe(f.project.workspaceRoot);
    },
  );
  it("blocks archived thread worktrees before transferring files", async () => {
    const f = await fixture();
    const threadId = ThreadId.makeUnsafe("archived-worktree");
    await f.dispatch({
      type: "thread.create",
      threadId,
      projectId: f.projectId,
      title: "Retained worktree",
      modelSelection: { provider: "codex", model: "gpt-5-codex" },
      runtimeMode: "approval-required",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: "feature",
      worktreePath: null,
      createdAt: now(),
    });
    await f.dispatch({ type: "thread.archive", threadId });
    // Retained SQL reference intentionally absent from the hot read-model window.
    await f.runSql(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE projection_threads SET worktree_path = '/retained/worktree' WHERE thread_id = ${threadId}`;
      }),
    );
    await fs.writeFile(path.join(f.project.workspaceRoot!, "keep"), "original");
    await expect(f.reconfigure("transfer")).rejects.toThrow("worktree");
    expect(await fs.readdir(f.destination)).toEqual([]);
    await f.dispatch({
      type: "project.meta.update",
      projectId: f.projectId,
      title: "Rename remains available",
    });
    expect((await f.read()).projects.find((entry) => entry.id === f.projectId)?.title).toBe(
      "Rename remains available",
    );
  });
  it.each(["opencodeV2", "muse"])(
    "refuses persisted %s ownership before transfer and preserves rename",
    async (provider) => {
      const f = await fixture();
      const threadId = ThreadId.makeUnsafe("native-owner");
      await f.dispatch({
        type: "thread.create",
        threadId,
        projectId: f.projectId,
        title: "Native history",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt: now(),
      });
      await f.runSql(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          if (provider === "opencodeV2") {
            yield* sql`INSERT INTO opencode_v2_shared_bindings (thread_id, material_json, state, revision)
            VALUES (${threadId}, '{}', 'verified', 0)`;
          } else {
            yield* sql`INSERT INTO muse_session_bindings
            (thread_id, native_session_id, creation_command_id, workspace, storage_identity, selection_fingerprint, created_at, phase)
            VALUES (${threadId}, 'native', 'created', ${f.project.workspaceRoot}, 'storage', 'selection', ${now()}, 'bound')`;
          }
        }),
      );
      await fs.writeFile(path.join(f.project.workspaceRoot!, "keep"), "original");
      await expect(f.reconfigure("transfer")).rejects.toThrow("provider-native history");
      await expect(
        f.dispatch({
          type: "project.reconfigure",
          projectId: f.projectId,
          title: f.project.title,
          providerRuntimeExecutionTargetId: "ssh:host",
          workspaceExecutionTargetId: "ssh:host",
          executionTargetId: "ssh:host",
          workspaceRoot: f.project.workspaceRoot,
          expectedUpdatedAt: f.project.updatedAt,
          verifiedWorktreePaths: [],
        }),
      ).rejects.toThrow("provider-native history");
      expect(await fs.readdir(f.destination)).toEqual([]);
      expect(
        (await f.read()).projects.find((entry) => entry.id === f.projectId)?.workspaceRoot,
      ).toBe(f.project.workspaceRoot);
      expect(await fs.readFile(path.join(f.project.workspaceRoot!, "keep"), "utf8")).toBe(
        "original",
      );
      await f.dispatch({
        type: "project.meta.update",
        projectId: f.projectId,
        title: "Native rename",
      });
      expect((await f.read()).projects.find((entry) => entry.id === f.projectId)?.title).toBe(
        "Native rename",
      );
    },
  );
  it("rejects metadata-update bypasses and remote name-only creation", async () => {
    const f = await fixture();
    await expect(
      f.dispatch({
        type: "project.meta.update",
        projectId: f.projectId,
        workspaceExecutionTargetId: "ssh:host",
      }),
    ).rejects.toThrow("project.reconfigure");
    await expect(
      f.dispatch({
        type: "project.meta.update",
        projectId: f.projectId,
        workspaceRoot: f.destination,
      }),
    ).rejects.toThrow("project.reconfigure");
    await expect(
      f.dispatch({
        type: "project.create",
        projectId: asProjectId("remote"),
        title: "Remote",
        workspaceRoot: null,
        workspaceExecutionTargetId: "ssh:host",
        createdAt: now(),
      }),
    ).rejects.toThrow("Remote projects require a directory");
  });
});
