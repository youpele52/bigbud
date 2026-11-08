import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { ThreadId, MessageId } from "@bigbud/contracts/core/baseSchemas";
import { ProviderTurnAdmissionsLive } from "../persistence/Layers/ProviderTurnAdmissions.ts";
import { ProviderTurnAdmissions } from "../persistence/Services/ProviderTurnAdmissions.ts";
import { MuseSessionBindingsLive } from "../persistence/Layers/MuseSessionBindings.ts";
import { MuseSessionBindings } from "../persistence/Services/MuseSessionBindings.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import migration from "../persistence/Migrations/147_ProjectWorkspaceNativeTransitions.ts";
import { reserveProjectWorkspaceTransition } from "./ProjectWorkspace.nativeReservation.ts";
import { archiveMuseWorkspaceBinding } from "./ProjectWorkspace.museArchive.ts";
import {
  assertProjectWorkspaceFinalize,
  finalizeProjectWorkspaceTransition,
} from "./ProjectWorkspace.nativeFinalize.ts";

const fixture = Effect.gen(function* () {
  const root = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), "bigbud-native-reservation-"))),
    (value) => Effect.promise(() => rm(value, { recursive: true, force: true })),
  );
  const sourcePath = path.join(root, "source");
  const destinationPath = path.join(root, "destination");
  yield* Effect.promise(async () => {
    await mkdir(sourcePath);
    await mkdir(destinationPath);
  });
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 145 });
  yield* migration;
  yield* sql`INSERT INTO projection_projects
    (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('project', 'Project', ${sourcePath}, '[]', 'now', 'now')`;
  for (const [threadId, provider] of [
    ["thread-v2", "opencodeV2"],
    ["thread-muse", "muse"],
  ]) {
    yield* sql`INSERT INTO projection_threads
      (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES (${threadId!}, 'project', 'Thread', ${JSON.stringify({ provider, model: `${provider}-chosen` })},
        'full-access', 'default', 'now', 'now')`;
  }
  const input = {
    operationId: "operation",
    commandId: "command",
    projectId: "project",
    requestDigest: "digest",
    requestJson: '{"acknowledged":true}',
    sourcePath,
    destinationPath,
  };
  const lease = (canonicalPath: string) => sql`INSERT INTO worktree_runtime_leases
    (lease_id, thread_id, runtime_kind, canonical_path, device, inode, acquired_at, updated_at)
    VALUES ('terminal', 'thread-v2', 'terminal', ${canonicalPath}, 123, 456, 'now', 'now')`;
  return { sql, input, lease };
});

it.effect(
  "native reservation fences terminal admission, retains retries, and never changes mixed selections",
  () =>
    Effect.gen(function* () {
      const { sql, input, lease } = yield* fixture;
      const selections =
        yield* sql`SELECT thread_id, model_selection_json FROM projection_threads ORDER BY thread_id`;
      assert.deepEqual(yield* reserveProjectWorkspaceTransition(sql, input), {
        operationId: "operation",
        phase: "prepared",
        retained: false,
      });
      const canonical = yield* Effect.promise(() => realpath(input.destinationPath));
      assert.isTrue((yield* Effect.result(lease(canonical)))._tag === "Failure");
      const shared = (
        thread: string,
        directory: string,
      ) => sql`INSERT INTO opencode_v2_shared_bindings
        (thread_id, material_json, state, revision) VALUES (${thread},
          ${JSON.stringify({ directory, workspaceTargetId: "local" })}, 'reserved', 0)`;
      const muse = (thread: string, workspace: string) => sql`INSERT INTO muse_session_bindings
        (thread_id, native_session_id, creation_command_id, workspace, storage_identity,
         selection_fingerprint, created_at, phase, revision)
        VALUES (${thread}, ${`native-${thread}`}, ${`create-${thread}`}, ${workspace}, 'storage', 'selection', 'now', 'reserved', 0)`;
      const admission = (
        thread: string,
        location: string,
      ) => sql`INSERT INTO provider_turn_admissions
        (namespace, owner_thread_id, request_message_id, binding_json, fingerprint,
         native_admission_id, turn_id, state, created_at, updated_at)
        VALUES ('foreground', ${thread}, 'message', ${JSON.stringify({ location, workspaceTargetId: "local" })},
          'fingerprint', 'admission', 'turn', 'reserved', 'now', 'now')`;
      for (const write of [
        shared("thread-v2", "/unrelated"),
        muse("thread-muse", "/unrelated"),
        admission("thread-v2", "/unrelated"),
        shared("other-shared", canonical),
        muse("other-muse", canonical),
        admission("other-admission", canonical),
      ]) {
        assert.isTrue((yield* Effect.result(write))._tag === "Failure");
      }
      // A transition never imposes a project-wide or global provider lock elsewhere.
      yield* shared("unrelated-shared", "/unrelated");
      yield* muse("unrelated-muse", "/unrelated");
      yield* admission("unrelated-admission", "/unrelated");
      assert.deepEqual(yield* reserveProjectWorkspaceTransition(sql, input), {
        operationId: "operation",
        phase: "prepared",
        retained: true,
      });
      assert.isTrue(
        (yield* Effect.result(
          reserveProjectWorkspaceTransition(sql, {
            ...input,
            requestDigest: "conflicting",
          }),
        ))._tag === "Failure",
      );
      assert.deepEqual(
        yield* sql`SELECT thread_id, model_selection_json FROM projection_threads ORDER BY thread_id`,
        selections,
      );
      assert.equal((yield* sql`SELECT * FROM worktree_operation_items`).length, 2);
      assert.isTrue(
        (yield* Effect.result(sql`INSERT INTO projection_threads
        (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
        VALUES ('new-thread', 'project', 'Thread', '{"provider":"codex","model":"chosen"}',
          'full-access', 'default', 'now', 'now')`))._tag === "Failure",
      );
      assert.isTrue(
        (yield* Effect.result(sql`UPDATE projection_projects SET title = 'Racing edit'
        WHERE project_id = 'project'`))._tag === "Failure",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "native reservation refuses an existing terminal atomically without leaving operation rows",
  () =>
    Effect.gen(function* () {
      const { sql, input, lease } = yield* fixture;
      const canonical = yield* Effect.promise(() => realpath(input.sourcePath));
      yield* lease(canonical);
      assert.isTrue(
        (yield* Effect.result(reserveProjectWorkspaceTransition(sql, input)))._tag === "Failure",
      );
      assert.equal((yield* sql`SELECT * FROM worktree_operations`).length, 0);
      assert.equal((yield* sql`SELECT * FROM project_workspace_native_operations`).length, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "exact verified finalization atomically commits metadata, receipt and immutable recovery evidence",
  () =>
    Effect.gen(function* () {
      const { sql, input, lease } = yield* fixture;
      yield* reserveProjectWorkspaceTransition(sql, input);
      const identity = { ...input };
      assert.isTrue(
        (yield* Effect.result(assertProjectWorkspaceFinalize(sql, identity)))._tag === "Failure",
      );
      yield* sql`UPDATE project_workspace_native_operations SET phase = 'native-verified' WHERE operation_id = 'operation'`;
      for (const forged of [
        { commandId: "wrong" },
        { projectId: "wrong" },
        { requestDigest: "wrong" },
        { destinationPath: "/wrong" },
        { operationId: "wrong" },
      ]) {
        assert.isTrue(
          (yield* Effect.result(assertProjectWorkspaceFinalize(sql, { ...identity, ...forged })))
            ._tag === "Failure",
        );
      }
      const commit = Effect.gen(function* () {
        yield* sql`INSERT INTO provider_workspace_binding_archives
        (archive_id, operation_id, thread_id, provider, native_session_id, workspace_root, recovery_json, created_at)
        VALUES ('archive', 'operation', 'thread-muse', 'muse', 'old-native', ${input.sourcePath}, '{"recovery":true}', 'now')`;
        yield* sql`UPDATE projection_projects SET workspace_root = ${input.destinationPath} WHERE project_id = 'project'`;
        yield* sql`INSERT INTO orchestration_command_receipts
        (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status,
         payload_digest_version, payload_digest)
        VALUES ('command', 'project', 'project', 'now', 42, 'accepted', 'test', 'digest')`;
        return { sequence: 42 };
      });
      const failed = yield* Effect.result(
        finalizeProjectWorkspaceTransition(
          sql,
          identity,
          commit.pipe(Effect.andThen(Effect.fail(new Error("injected post-receipt SQL failure")))),
        ),
      );
      assert.isTrue(failed._tag === "Failure");
      assert.deepEqual(
        yield* sql`SELECT workspace_root FROM projection_projects WHERE project_id = 'project'`,
        [{ workspace_root: input.sourcePath }],
      );
      assert.equal((yield* sql`SELECT * FROM provider_workspace_binding_archives`).length, 0);
      assert.equal((yield* sql`SELECT * FROM orchestration_command_receipts`).length, 0);
      assert.deepEqual(yield* sql`SELECT phase FROM project_workspace_native_operations`, [
        { phase: "native-verified" },
      ]);
      const canonical = yield* Effect.promise(() => realpath(input.destinationPath));
      assert.isTrue((yield* Effect.result(lease(canonical)))._tag === "Failure");
      assert.deepEqual(yield* finalizeProjectWorkspaceTransition(sql, identity, commit), {
        sequence: 42,
      });
      assert.deepEqual(
        yield* sql`SELECT workspace_root FROM projection_projects WHERE project_id = 'project'`,
        [{ workspace_root: input.destinationPath }],
      );
      assert.equal((yield* sql`SELECT * FROM provider_workspace_binding_archives`).length, 1);
      assert.equal((yield* sql`SELECT * FROM orchestration_command_receipts`).length, 1);
      assert.deepEqual(
        yield* sql`SELECT phase, result_sequence FROM project_workspace_native_operations`,
        [{ phase: "committed", result_sequence: 42 }],
      );
      yield* lease(canonical);
      for (const provider of ["codex", "muse", "opencodeV2"]) {
        yield* sql`INSERT INTO projection_threads
        (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
        VALUES (${`new-${provider}`}, 'project', 'Thread', ${JSON.stringify({ provider, model: `${provider}-chosen` })},
          'full-access', 'default', 'now', 'now')`;
      }
      assert.equal((yield* sql`SELECT * FROM projection_threads`).length, 5);
    }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "archives dormant Muse incarnations atomically without changing a current different provider or model",
  () =>
    Effect.gen(function* () {
      const { sql, input } = yield* fixture;
      yield* sql`UPDATE projection_threads SET model_selection_json = '{"provider":"codex","model":"explicit-codex"}'
      WHERE thread_id = 'thread-muse'`;
      yield* sql`INSERT INTO provider_session_runtime
      (thread_id, provider_name, adapter_key, status, last_seen_at, resume_cursor_json, runtime_payload_json)
      VALUES ('thread-muse', 'codex', 'codex', 'stopped', 'now', '{"keep":"codex-cursor"}', '{"cwd":"old"}')`;
      yield* sql`INSERT INTO muse_session_bindings
      (thread_id, native_session_id, creation_command_id, workspace, storage_identity,
       selection_fingerprint, created_at, phase, revision)
      VALUES ('thread-muse', 'muse-original', 'muse-create', ${input.sourcePath}, 'storage', 'historic-selection', 'now', 'bound', 1)`;
      for (const nativeSessionId of ["muse-original", "muse-older"]) {
        yield* sql`INSERT INTO provider_turn_admissions
        (namespace, owner_thread_id, request_message_id, binding_json, fingerprint,
         native_admission_id, turn_id, state, created_at, updated_at)
        VALUES (${nativeSessionId === "muse-older" ? "learning" : "foreground"},
          ${nativeSessionId === "muse-older" ? "learning-owner" : "thread-muse"}, ${nativeSessionId},
          ${JSON.stringify({
            provider: "muse",
            threadId: "thread-muse",
            nativeSessionId,
            location: input.sourcePath,
            workspaceTargetId: "local",
            runtimeTargetId: "local",
            storageIdentity: "storage",
          })},
          'immutable-fingerprint', ${nativeSessionId}, ${nativeSessionId}, 'terminal', 'now', 'now')`;
      }
      yield* reserveProjectWorkspaceTransition(sql, input);
      const archive = archiveMuseWorkspaceBinding(sql, {
        operationId: input.operationId,
        threadId: "thread-muse",
        nativeSessionId: "muse-original",
        revision: 1,
      });
      assert.isTrue((yield* Effect.result(archive))._tag === "Failure");
      yield* sql`UPDATE project_workspace_native_operations SET phase = 'native-verified' WHERE operation_id = 'operation'`;
      const commit = Effect.gen(function* () {
        assert.deepEqual(yield* archive, { archivedNativeSessions: 2 });
        yield* sql`UPDATE projection_projects SET workspace_root = ${input.destinationPath} WHERE project_id = 'project'`;
        return { sequence: 7 };
      });
      assert.isTrue(
        (yield* Effect.result(
          finalizeProjectWorkspaceTransition(
            sql,
            input,
            commit.pipe(Effect.andThen(Effect.fail(new Error("injected archive rollback")))),
          ),
        ))._tag === "Failure",
      );
      assert.equal((yield* sql`SELECT * FROM muse_session_bindings`).length, 1);
      assert.equal((yield* sql`SELECT * FROM provider_workspace_binding_archives`).length, 0);
      yield* finalizeProjectWorkspaceTransition(sql, input, commit);
      assert.equal((yield* sql`SELECT * FROM muse_session_bindings`).length, 0);
      assert.equal((yield* sql`SELECT * FROM provider_workspace_binding_archives`).length, 2);
      assert.equal((yield* sql`SELECT * FROM provider_workspace_archived_admissions`).length, 2);
      assert.equal((yield* sql`SELECT * FROM provider_turn_admissions`).length, 2);
      assert.deepEqual(
        yield* sql`SELECT provider_name, resume_cursor_json FROM provider_session_runtime WHERE thread_id = 'thread-muse'`,
        [{ provider_name: "codex", resume_cursor_json: '{"keep":"codex-cursor"}' }],
      );
      assert.deepEqual(
        yield* sql`SELECT model_selection_json FROM projection_threads WHERE thread_id = 'thread-muse'`,
        [{ model_selection_json: '{"provider":"codex","model":"explicit-codex"}' }],
      );
      assert.isTrue((yield* Effect.result(archive))._tag === "Failure");
      const admissions = yield* Effect.gen(function* () {
        return yield* ProviderTurnAdmissions;
      }).pipe(Effect.provide(ProviderTurnAdmissionsLive));
      const museBindings = yield* Effect.gen(function* () {
        return yield* MuseSessionBindings;
      }).pipe(Effect.provide(MuseSessionBindingsLive));
      const threadId = ThreadId.makeUnsafe("thread-muse");
      assert.isUndefined(yield* admissions.latestBound(threadId));
      assert.deepEqual(yield* admissions.listBound(threadId, 10), []);
      assert.deepEqual(yield* admissions.listBoundPage({ threadId, limit: 10 }), []);
      assert.isDefined(
        yield* admissions.find({
          namespace: "foreground",
          ownerThreadId: threadId,
          requestMessageId: MessageId.makeUnsafe("muse-original"),
        }),
      );
      assert.isTrue(yield* museBindings.isArchived!(threadId, "muse-original"));
      assert.isFalse(yield* museBindings.isArchived!(threadId, "fresh-muse"));
      const reserve = (nativeSessionId: string) =>
        museBindings.reserve({
          threadId,
          nativeSessionId,
          creationCommandId: `create-${nativeSessionId}`,
          workspace: input.destinationPath,
          storageIdentity: "storage",
          selectionFingerprint: "then-current-explicit-muse-selection",
          createdAt: "now",
        });
      assert.isTrue((yield* Effect.result(reserve("muse-original")))._tag === "Failure");
      assert.equal((yield* reserve("fresh-muse")).nativeSessionId, "fresh-muse");
    }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layerMemory())),
);
