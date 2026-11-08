import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import migration from "../persistence/Migrations/147_ProjectWorkspaceNativeTransitions.ts";
import {
  reconcileProjectWorkspaceTransition,
  type ProjectWorkspaceNativeStep,
} from "./ProjectWorkspace.nativeRecovery.ts";
import { assertProjectWorkspaceFinalize } from "./ProjectWorkspace.nativeFinalize.ts";

it("reconciles retained partial dispatch after SQLite restart without replay or dormant provider launch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bigbud-native-restart-"));
  const filename = path.join(root, "journal.sqlite");
  const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.runPromise(effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename }))));
  const identity = {
    created: 1,
    model: { id: "chosen", providerID: "provider" },
    metadata: { owner: "v2-thread" },
  };
  const steps: ProjectWorkspaceNativeStep[] = [
    {
      provider: "opencodeV2",
      threadId: "v2-thread",
      nativeSessionId: "native-v2",
      storageIdentity: "storage",
      sourceDirectory: "/old",
      destinationDirectory: "/new",
      phase: "dispatched",
      expectedIdentity: identity,
    },
    {
      provider: "muse",
      threadId: "dormant-muse",
      nativeSessionId: "native-muse",
      phase: "archive-ready",
    },
  ];
  const input = { operationId: "operation", requestDigest: "digest" };
  try {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 145 });
        yield* migration;
        yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES ('project', 'Project', '/old', '[]', 'now', 'now')`;
        yield* sql`INSERT INTO worktree_operations
        (operation_id, request_digest, kind, repository, cwd, source_path, destination_path,
         canonical_path, device, inode, branch, phase, created_at)
        VALUES ('operation', 'digest', 'access', '/old', '/old', '/old', '/new', '/old', 1, 2,
          'workspace-mutation', 'dispatched', 'now')`;
        yield* sql`INSERT INTO project_workspace_native_operations
        (operation_id, command_id, project_id, request_json, source_path, destination_path,
         phase, steps_json, created_at, updated_at)
        VALUES ('operation', 'command', 'project', '{}', '/old', '/new', 'native-dispatched',
          ${JSON.stringify(steps)}, 'now', 'now')`;
      }),
    );
    const inspect = vi.fn((step: Extract<ProjectWorkspaceNativeStep, { provider: "opencodeV2" }>) =>
      Effect.succeed({
        nativeSessionId: step.nativeSessionId,
        storageIdentity: "storage",
        directory: "/old",
        identity,
      }),
    );
    const first = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* reconcileProjectWorkspaceTransition(sql, input, inspect);
      }),
    );
    expect(first.status).toBe("recovery-required");
    expect("error" in first && first.error).toContain("No uncertain move was resent");
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(inspect.mock.calls[0]?.[0].provider).toBe("opencodeV2");
    inspect.mockImplementation((step) =>
      Effect.succeed({
        nativeSessionId: `${step.nativeSessionId}-foreign`,
        storageIdentity: "storage",
        directory: "/new",
        identity,
      }),
    );
    const foreign = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* reconcileProjectWorkspaceTransition(sql, input, inspect);
      }),
    );
    expect(foreign.status).toBe("recovery-required");
    expect("error" in foreign && foreign.error).toContain("ownership changed");
    inspect.mockImplementation((step) =>
      Effect.succeed({
        nativeSessionId: step.nativeSessionId,
        storageIdentity: "storage",
        directory: "/third",
        identity,
      }),
    );
    const third = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* reconcileProjectWorkspaceTransition(sql, input, inspect);
      }),
    );
    expect(third.status).toBe("recovery-required");
    expect("error" in third && third.error).toContain("unrecorded native Location");
    inspect.mockImplementation((step) =>
      Effect.succeed({
        nativeSessionId: step.nativeSessionId,
        storageIdentity: "storage",
        directory: "/new",
        identity,
      }),
    );
    const second = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const blocked = yield* Effect.result(sql`INSERT INTO projection_threads
        (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
        VALUES ('racing', 'project', 'Thread', '{"provider":"codex","model":"explicit"}', 'full-access', 'default', 'now', 'now')`);
        expect(blocked._tag).toBe("Failure");
        return yield* reconcileProjectWorkspaceTransition(sql, input, inspect);
      }),
    );
    expect(second.status).toBe("ready-to-finalize");
    expect(inspect).toHaveBeenCalledTimes(4);
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* assertProjectWorkspaceFinalize(sql, {
          ...input,
          commandId: "command",
          projectId: "project",
          destinationPath: "/new",
        });
        const rows = yield* sql<{
          stepsJson: string;
        }>`SELECT steps_json AS "stepsJson" FROM project_workspace_native_operations`;
        expect(JSON.parse(rows[0]!.stepsJson)).toEqual([
          { ...steps[0], phase: "verified" },
          steps[1],
        ]);
        expect(
          (yield* sql`SELECT workspace_root FROM projection_projects WHERE project_id = 'project'`)[0],
        ).toEqual({ workspace_root: "/old" });
        const wrong = yield* Effect.result(
          reconcileProjectWorkspaceTransition(sql, { ...input, requestDigest: "wrong" }, inspect),
        );
        expect(wrong._tag).toBe("Failure");
      }),
    );
    expect(inspect).toHaveBeenCalledTimes(4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
