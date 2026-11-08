import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ThreadId, MessageId } from "@bigbud/contracts/core/baseSchemas";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "../Migrations/147_ProjectWorkspaceNativeTransitions.ts";
import { ProviderTurnAdmissions } from "../Services/ProviderTurnAdmissions.ts";
import { ProviderTurnAdmissionsLive } from "./ProviderTurnAdmissions.ts";

it.effect(
  "resolves committed exact-owner V2 Location lineage without rewriting historical bindings or fingerprints",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 145 });
      yield* migration;
      const binding = {
        provider: "opencodeV2",
        threadId: ThreadId.makeUnsafe("thread"),
        nativeSessionId: "native",
        storageIdentity: "storage",
        location: "/a",
        runtimeTargetId: "local",
        workspaceTargetId: "local",
      };
      yield* sql`INSERT INTO provider_turn_admissions
      (namespace, owner_thread_id, request_message_id, binding_json, fingerprint,
       native_admission_id, turn_id, state, created_at, updated_at)
      VALUES ('foreground', 'thread', 'message', ${JSON.stringify(binding)}, 'original-fingerprint',
        'admission', 'turn', 'terminal', 'now', 'now')`;
      let sequence = 0;
      for (const [oldLocation, newLocation, committed] of [
        ["/a", "/b", true],
        ["/b", "/a", true],
        ["/a", "/c", true],
        ["/c", "/d", false],
      ] as const) {
        sequence++;
        const operationId = `operation-${sequence}`;
        yield* sql`INSERT INTO worktree_operations
        (operation_id, request_digest, kind, repository, cwd, source_path, destination_path,
         canonical_path, device, inode, branch, phase, created_at)
        VALUES (${operationId}, ${operationId}, 'access', ${oldLocation}, ${oldLocation},
          ${oldLocation}, ${newLocation}, ${oldLocation}, 1, 2, 'workspace-mutation',
          ${committed ? "completed" : "prepared"}, 'now')`;
        yield* sql`INSERT INTO project_workspace_native_operations
        (operation_id, command_id, project_id, request_json, source_path, destination_path,
         phase, steps_json, result_sequence, created_at, updated_at)
        VALUES (${operationId}, ${operationId}, 'project', '{}', ${oldLocation}, ${newLocation},
          ${committed ? "committed" : "native-verified"}, '[]', ${committed ? sequence : null}, 'now', 'now')`;
        yield* sql`INSERT INTO provider_workspace_location_lineage
        (operation_id, thread_id, provider, native_session_id, storage_identity, old_location, new_location, verified_at)
        VALUES (${operationId}, 'thread', 'opencodeV2', 'native', 'storage', ${oldLocation}, ${newLocation}, 'same-timestamp')`;
      }
      const journal = yield* Effect.gen(function* () {
        return yield* ProviderTurnAdmissions;
      }).pipe(Effect.provide(ProviderTurnAdmissionsLive));
      for (const location of ["/a", "/b", "/c"]) {
        assert.equal(yield* journal.effectiveWorkspaceLocation!({ ...binding, location }), "/c");
      }
      assert.equal(
        yield* journal.effectiveWorkspaceLocation!({
          ...binding,
          storageIdentity: "foreign-storage",
        }),
        "/a",
      );
      assert.equal(
        yield* journal.effectiveWorkspaceLocation!({
          ...binding,
          nativeSessionId: "foreign-native",
        }),
        "/a",
      );
      assert.isTrue(
        (yield* Effect.result(
          journal.effectiveWorkspaceLocation!({ ...binding, location: "/unknown" }),
        ))._tag === "Failure",
      );
      const historical = yield* journal.find({
        namespace: "foreground",
        ownerThreadId: binding.threadId,
        requestMessageId: MessageId.makeUnsafe("message"),
      });
      assert.deepEqual(historical?.binding, binding);
      assert.equal(historical?.fingerprint, "original-fingerprint");
      assert.deepEqual((yield* journal.latestBound(binding.threadId))?.binding, binding);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
