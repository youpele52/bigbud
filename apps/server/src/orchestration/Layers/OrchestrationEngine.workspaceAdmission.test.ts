import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { CommandId, ThreadId, DEFAULT_PROVIDER_INTERACTION_MODE } from "@bigbud/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { withWorktreeAccess } from "../../git/Layers/WorktreeAccess.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { asProjectId, createOrchestrationSystem, now } from "./OrchestrationEngine.test.helpers.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, copyFile: vi.fn(actual.copyFile) };
});
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.mocked(fs.copyFile).mockRestore();
  for (const dispose of cleanup.splice(0).toReversed()) await dispose();
});

it.each(["success", "copy-failure", "commit-failure"] as const)(
  "fences real generic engine transfer (%s) until settled commit or rollback",
  async (outcome) => {
    const system = await createOrchestrationSystem();
    cleanup.push(system.dispose);
    const destination = await fs.mkdtemp(path.join(tmpdir(), "bigbud-workspace-admission-"));
    cleanup.push(() => fs.rm(destination, { recursive: true, force: true }));
    const projectId = asProjectId("admission-project");
    const threadId = ThreadId.makeUnsafe("admission-thread");
    await system.run(
      system.engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("create"),
        projectId,
        title: "Managed",
        workspaceRoot: null,
        createdAt: now(),
      }),
    );
    const before = await system.run(system.engine.getReadModel());
    const project = before.projects.find((p) => p.id === projectId)!;
    cleanup.push(() => fs.rm(project.workspaceRoot!, { recursive: true, force: true }));
    await system.run(
      system.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("thread"),
        threadId,
        projectId,
        title: "Owner",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt: now(),
      }),
    );
    await fs.writeFile(path.join(project.workspaceRoot!, "keep"), "recovery data");
    const terminal = (cwd: string) =>
      system.runSql(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql`INSERT INTO worktree_runtime_leases
      (lease_id, thread_id, runtime_kind, canonical_path, device, inode, acquired_at, updated_at)
      VALUES ('racing-terminal', ${threadId}, 'terminal', ${cwd}, 123, 456, 'now', 'now')`;
        }),
      );
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const observed: string[] = [];
    vi.mocked(fs.copyFile).mockImplementationOnce(async (...args) => {
      // This callback is inside real filesystem staging, not a reservation helper test.
      for (const cwd of [project.workspaceRoot!, destination, "/thread-alias"]) {
        await expect(terminal(cwd)).rejects.toThrow();
        observed.push(cwd);
      }
      await expect(
        system.runSql(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* withWorktreeAccess(
              sql,
              { cwd: destination, repository: destination, blocksRuntime: true },
              Effect.die("Mutation must not dispatch"),
            );
          }),
        ),
      ).rejects.toThrow("workspace_busy");
      expect(
        (await system.run(system.engine.getReadModel())).projects.find((p) => p.id === projectId)
          ?.workspaceRoot,
      ).toBe(project.workspaceRoot);
      await actual.copyFile(...args);
      if (outcome === "copy-failure") throw new Error("injected copy failure after first file");
    });
    await system.runSql(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Admission must remain owned at the actual application metadata commit boundary.
        yield* sql`CREATE TRIGGER require_workspace_fence BEFORE UPDATE OF workspace_root ON projection_projects
      WHEN NEW.project_id = 'admission-project' AND NOT EXISTS (
        SELECT 1 FROM worktree_operations WHERE branch = 'workspace-mutation' AND phase = 'dispatched')
      BEGIN SELECT RAISE(ABORT, 'workspace fence missing at commit'); END`;
        if (outcome === "commit-failure")
          yield* sql`CREATE TRIGGER reject_workspace_commit
        BEFORE UPDATE OF workspace_root ON projection_projects
        BEGIN SELECT RAISE(ABORT, 'injected commit rollback'); END`;
      }),
    );
    const dispatch = system.run(
      system.engine.dispatch({
        type: "project.reconfigure",
        commandId: CommandId.makeUnsafe("transfer"),
        projectId,
        title: project.title,
        executionTargetId: "local",
        providerRuntimeExecutionTargetId: "local",
        workspaceExecutionTargetId: "local",
        workspaceRoot: destination,
        expectedUpdatedAt: project.updatedAt,
        verifiedWorktreePaths: [],
        workspaceAction: "transfer",
      }),
    );
    if (outcome === "success") await dispatch;
    else
      await expect(dispatch).rejects.toThrow(
        outcome === "copy-failure" ? "Transfer failed" : "Could not confirm the folder change",
      );
    expect(observed).toHaveLength(3);
    expect(
      (await system.run(system.engine.getReadModel())).projects.find((p) => p.id === projectId)
        ?.workspaceRoot,
    ).toBe(outcome === "success" ? destination : project.workspaceRoot);
    await terminal(outcome === "success" ? destination : project.workspaceRoot!);
    for (const root of [project.workspaceRoot!, destination])
      expect(await fs.readFile(path.join(root, "keep"), "utf8")).toBe("recovery data");
    const pending = await system.runSql(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql`SELECT * FROM worktree_operations WHERE branch = 'workspace-mutation'`;
      }),
    );
    expect(pending).toEqual([]);
  },
);
