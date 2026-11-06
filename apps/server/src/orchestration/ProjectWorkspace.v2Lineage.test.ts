import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { ThreadId } from "@bigbud/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import migration from "../persistence/Migrations/147_ProjectWorkspaceNativeTransitions.ts";
import { commitV2WorkspaceLineage } from "./ProjectWorkspace.v2Lineage.ts";
import { finalizeProjectWorkspaceTransition } from "./ProjectWorkspace.nativeFinalize.ts";
import { effectiveProviderWorkspaceLocation } from "../persistence/Layers/ProviderWorkspaceActiveView.ts";

it.effect(
  "atomically commits exact V2 Location lineage and preserves native/model/history identity across rollback",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 145 });
      yield* migration;
      yield* sql`INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('project', 'Project', '/old', '[]', 'now', 'now')`;
      for (const thread of ["v2-thread", "other-thread"])
        yield* sql`INSERT INTO projection_threads
      (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES (${thread}, 'project', 'Thread', '{"provider":"opencodeV2","model":"chosen"}', 'full-access', 'default', 'now', 'now')`;
      const material = {
        threadId: "v2-thread",
        nativeSessionId: "native",
        storageIdentity: "storage",
        directory: "/old",
        runtimeTargetId: "local",
        workspaceTargetId: "local",
        identityKind: "shared-api-v1",
        material: "immutable-model-material",
      };
      yield* sql`INSERT INTO opencode_v2_shared_bindings (thread_id, material_json, state, revision)
      VALUES ('v2-thread', ${JSON.stringify(material)}, 'verified', 2)`;
      const cursor = {
        provider: "opencodeV2",
        nativeSessionId: "native",
        storageIdentity: "storage",
        directory: "/old",
        model: { id: "chosen", providerID: "provider" },
      };
      for (const thread of ["v2-thread", "other-thread"])
        yield* sql`INSERT INTO provider_session_runtime
      (thread_id, provider_name, adapter_key, status, last_seen_at, resume_cursor_json, runtime_payload_json)
      VALUES (${thread}, 'opencodeV2', 'opencodeV2', 'stopped', 'now', ${JSON.stringify(cursor)}, '{"cwd":"/old","preserved":true}')`;
      const binding = {
        provider: "opencodeV2" as const,
        threadId: ThreadId.makeUnsafe("v2-thread"),
        nativeSessionId: "native",
        storageIdentity: "storage",
        location: "/old",
        runtimeTargetId: "local",
        workspaceTargetId: "local",
      };
      yield* sql`INSERT INTO provider_turn_admissions
      (namespace, owner_thread_id, request_message_id, binding_json, fingerprint, native_admission_id, turn_id, state, created_at, updated_at)
      VALUES ('foreground', 'v2-thread', 'message', ${JSON.stringify(binding)}, 'immutable', 'native-message', 'turn', 'terminal', 'now', 'now')`;
      const oldRuntime =
        yield* sql`SELECT * FROM provider_session_runtime WHERE thread_id = 'other-thread'`;
      const oldAdmissions = yield* sql`SELECT * FROM provider_turn_admissions`;
      const steps = [
        {
          provider: "opencodeV2",
          threadId: "v2-thread",
          nativeSessionId: "native",
          storageIdentity: "storage",
          sourceDirectory: "/old",
          destinationDirectory: "/new",
          phase: "verified",
          expectedIdentity: { created: 123, model: null, metadata: null },
        },
      ];
      yield* sql`INSERT INTO worktree_operations
      (operation_id, request_digest, kind, repository, cwd, source_path, destination_path, canonical_path, device, inode, branch, phase, created_at)
      VALUES ('operation', 'digest', 'access', '/old', '/old', '/old', '/new', '/old', 1, 1, 'workspace-mutation', 'dispatched', 'now')`;
      yield* sql`INSERT INTO project_workspace_native_operations
      (operation_id, command_id, project_id, request_json, source_path, destination_path, phase, steps_json, created_at, updated_at)
      VALUES ('operation', 'command', 'project', '{}', '/old', '/new', 'native-verified', ${JSON.stringify(steps)}, 'now', 'now')`;
      const identity = {
        operationId: "operation",
        commandId: "command",
        projectId: "project",
        requestDigest: "digest",
        destinationPath: "/new",
      };
      const rebind = commitV2WorkspaceLineage(sql, {
        operationId: "operation",
        threadId: "v2-thread",
        nativeSessionId: "native",
        revision: 2,
      });
      assert.equal((yield* Effect.result(rebind))._tag, "Failure");
      const commit = Effect.gen(function* () {
        yield* rebind;
        yield* sql`UPDATE projection_projects SET workspace_root = '/new' WHERE project_id = 'project'`;
        return { sequence: 10 };
      });
      const failed = yield* finalizeProjectWorkspaceTransition(
        sql,
        identity,
        commit.pipe(Effect.andThen(Effect.fail(new Error("injected application failure")))),
      ).pipe(Effect.result);
      assert.equal(failed._tag, "Failure");
      assert.deepEqual(yield* sql`SELECT * FROM provider_workspace_location_lineage`, []);
      assert.deepEqual(yield* sql`SELECT * FROM provider_workspace_binding_archives`, []);
      assert.deepEqual(
        JSON.parse(
          (yield* sql<{
            material: string;
          }>`SELECT material_json AS material FROM opencode_v2_shared_bindings`)[0]!.material,
        ),
        material,
      );
      yield* finalizeProjectWorkspaceTransition(sql, identity, commit);
      const moved = (yield* sql<{
        material: string;
        revision: number;
      }>`SELECT material_json AS material, revision FROM opencode_v2_shared_bindings`)[0]!;
      assert.deepEqual(JSON.parse(moved.material), { ...material, directory: "/new" });
      assert.equal(moved.revision, 3);
      assert.equal(yield* effectiveProviderWorkspaceLocation(sql, binding), "/new");
      assert.deepEqual(yield* sql`SELECT * FROM provider_turn_admissions`, oldAdmissions);
      assert.deepEqual(
        yield* sql`SELECT * FROM provider_session_runtime WHERE thread_id = 'other-thread'`,
        oldRuntime,
      );
      const runtime = (yield* sql<{
        cursor: string;
        payload: string;
      }>`SELECT resume_cursor_json AS cursor, runtime_payload_json AS payload
      FROM provider_session_runtime WHERE thread_id = 'v2-thread'`)[0]!;
      assert.deepEqual(JSON.parse(runtime.cursor), { ...cursor, directory: "/new" });
      assert.deepEqual(JSON.parse(runtime.payload), { cwd: "/new", preserved: true });
      assert.equal((yield* sql`SELECT * FROM provider_workspace_binding_archives`).length, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layerMemory())),
);
