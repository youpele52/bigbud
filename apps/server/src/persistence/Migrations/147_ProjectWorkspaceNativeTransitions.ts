import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { installProjectWorkspaceNativeGuards } from "./ProjectWorkspaceNativeGuards.ts";

/** Application-owned recovery evidence; never provider-owned database mutations. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_workspace_native_operations (
    operation_id TEXT PRIMARY KEY REFERENCES worktree_operations(operation_id),
    command_id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    request_json TEXT NOT NULL,
    source_path TEXT NOT NULL,
    destination_path TEXT NOT NULL,
    source_identity_json TEXT NOT NULL DEFAULT '{}',
    destination_identity_json TEXT NOT NULL DEFAULT '{}',
    phase TEXT NOT NULL CHECK(phase IN ('prepared','files-ready','native-dispatched','native-verified','committed','recovery-required','rejected')),
    steps_json TEXT NOT NULL,
    result_sequence INTEGER,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TRIGGER project_workspace_native_identity_immutable
    BEFORE UPDATE OF operation_id, command_id, project_id, request_json, source_path, destination_path, source_identity_json, destination_identity_json
    ON project_workspace_native_operations
    BEGIN SELECT RAISE(ABORT, 'workspace native operation identity is immutable'); END`;
  yield* sql`CREATE UNIQUE INDEX project_workspace_native_active_project
    ON project_workspace_native_operations(project_id) WHERE phase NOT IN ('committed','rejected')`;
  yield* sql`CREATE TABLE provider_workspace_binding_archives (
    archive_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL REFERENCES project_workspace_native_operations(operation_id),
    thread_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK(provider IN ('opencodeV2','muse')),
    native_session_id TEXT NOT NULL,
    workspace_root TEXT NOT NULL,
    recovery_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(operation_id, thread_id, provider, native_session_id)
  )`;
  yield* sql`CREATE TABLE provider_workspace_archived_admissions (
    archive_id TEXT NOT NULL REFERENCES provider_workspace_binding_archives(archive_id),
    namespace TEXT NOT NULL,
    owner_thread_id TEXT NOT NULL,
    request_message_id TEXT NOT NULL,
    PRIMARY KEY(namespace, owner_thread_id, request_message_id)
  )`;
  yield* sql`CREATE TABLE provider_workspace_location_lineage (
    operation_id TEXT NOT NULL REFERENCES project_workspace_native_operations(operation_id),
    thread_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK(provider = 'opencodeV2'),
    native_session_id TEXT NOT NULL,
    storage_identity TEXT NOT NULL,
    old_location TEXT NOT NULL,
    new_location TEXT NOT NULL,
    verified_at TEXT NOT NULL,
    PRIMARY KEY(operation_id, thread_id, native_session_id)
  )`;
  for (const table of [
    "provider_workspace_binding_archives",
    "provider_workspace_archived_admissions",
    "provider_workspace_location_lineage",
  ]) {
    yield* sql.unsafe(`CREATE TRIGGER ${table}_immutable_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT, 'workspace recovery evidence is immutable'); END`);
    yield* sql.unsafe(`CREATE TRIGGER ${table}_immutable_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT, 'workspace recovery evidence cannot be discarded'); END`);
  }
  yield* installProjectWorkspaceNativeGuards(sql);
});
