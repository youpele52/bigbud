import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  CommandId,
  ThreadId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type OrchestrationCommand,
} from "@bigbud/contracts";
import { expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { asProjectId, createOrchestrationSystem, now } from "./OrchestrationEngine.test.helpers.ts";
import { calculateCommandPayloadDigest } from "../commandDigest.ts";
import { reserveProjectWorkspaceTransition } from "../ProjectWorkspace.nativeReservation.ts";
import { copyWorkspaceFiles } from "../ProjectWorkspace.files.ts";

it("actual engine restart inspects staged Muse recovery without committing or recreating sessions", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "bigbud-workspace-restart-"));
  const databaseFilename = path.join(root, "state.sqlite");
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  await fs.mkdir(source);
  await fs.mkdir(destination);
  let system = await createOrchestrationSystem({ databaseFilename });
  let disposed = false;
  try {
    const projectId = asProjectId("restart-project");
    await system.run(
      system.engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("create"),
        projectId,
        title: "Restart",
        workspaceRoot: source,
        createdAt: now(),
      }),
    );
    await system.run(
      system.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("thread"),
        projectId,
        threadId: ThreadId.makeUnsafe("cold"),
        title: "Cold dormant Muse owner",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt: now(),
      }),
    );
    const before = await system.run(system.engine.getReadModel());
    const project = before.projects.find((entry) => entry.id === projectId)!;
    const command: OrchestrationCommand = {
      type: "project.reconfigure",
      commandId: CommandId.makeUnsafe("retry"),
      projectId,
      title: project.title,
      workspaceRoot: destination,
      expectedUpdatedAt: project.updatedAt,
      verifiedWorktreePaths: [],
      executionTargetId: "local",
      workspaceExecutionTargetId: "local",
      providerRuntimeExecutionTargetId: "local",
      nativeContextReset: "archive-and-reset-muse",
    };
    await system.runSql(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO muse_session_bindings
        (thread_id, native_session_id, creation_command_id, workspace, storage_identity, selection_fingerprint, created_at, phase, revision)
        VALUES ('cold', 'old-native', 'old-create', ${source}, 'storage', 'historic-model', 'now', 'bound', 1)`;
        yield* reserveProjectWorkspaceTransition(sql, {
          operationId: "restart-operation",
          commandId: command.commandId,
          projectId,
          requestDigest: calculateCommandPayloadDigest(command).digest,
          requestJson: JSON.stringify(command),
          sourcePath: source,
          destinationPath: destination,
        });
      }),
    );
    await fs.writeFile(path.join(source, "keep"), "recovery copy");
    await copyWorkspaceFiles(source, destination);
    await system.runSql(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE project_workspace_native_operations SET phase = 'files-ready', steps_json = ${JSON.stringify(
          [
            {
              provider: "muse",
              threadId: "cold",
              nativeSessionId: "old-native",
              phase: "archive-ready",
            },
          ],
        )} WHERE operation_id = 'restart-operation'`;
      }),
    );
    await system.dispose();
    disposed = true;
    system = await createOrchestrationSystem({ databaseFilename });
    disposed = false;
    const recovered = await system.runSql(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return {
          journal: yield* sql`SELECT phase FROM project_workspace_native_operations`,
          fence:
            yield* sql`SELECT phase FROM worktree_operations WHERE operation_id = 'restart-operation'`,
          bindings: yield* sql`SELECT native_session_id FROM muse_session_bindings`,
          archives: yield* sql`SELECT * FROM provider_workspace_binding_archives`,
        };
      }),
    );
    expect(recovered.journal).toEqual([{ phase: "native-verified" }]);
    expect(await system.run(system.engine.getCommandOutcome!(command.commandId))).toMatchObject({
      status: "unknown",
      workspaceTransition: {
        operationId: "restart-operation",
        phase: "native-verified",
        sourcePath: source,
        destinationPath: destination,
      },
    });
    expect(recovered.fence[0]?.phase).not.toBe("completed");
    expect(recovered.bindings).toEqual([{ native_session_id: "old-native" }]);
    expect(recovered.archives).toEqual([]);
    const persistedRoot = await system.runSql(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql`SELECT workspace_root FROM projection_projects WHERE project_id = ${projectId}`;
      }),
    );
    expect(persistedRoot).toEqual([{ workspace_root: source }]);
    if (system.engine.ensureThreadState)
      await system.run(system.engine.ensureThreadState(ThreadId.makeUnsafe("cold"), "history"));
    // No adapters or native services exist in this real engine fixture. Startup can only inspect SQL.
    await system.run(
      system.engine.dispatch(command, { nativeWorkspaceOperationId: "restart-operation" }),
    );
    const after = await system.run(system.engine.getReadModel());
    expect(after.projects.find((entry) => entry.id === projectId)?.workspaceRoot).toBe(destination);
    expect(after.threads.find((entry) => entry.id === "cold")?.modelSelection).toEqual(
      before.threads[0]?.modelSelection,
    );
    for (const directory of [source, destination])
      expect(await fs.readFile(path.join(directory, "keep"), "utf8")).toBe("recovery copy");
  } finally {
    if (!disposed) await system.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});
