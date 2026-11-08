import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

const normalize = (value: string) =>
  process.platform === "win32" ? `lower(replace(${value}, char(92), '/'))` : value;

const overlap = (left: string, right: string) => {
  const a = normalize(left),
    b = normalize(right);
  return `(${a} = ${b} OR substr(${a},1,length(${b})+1) = ${b} || '/' OR substr(${b},1,length(${a})+1) = ${a} || '/')`;
};

/** Native writes must honor project workspace access reservations, including dormant owners.
 * The finalizer releases its operation inside the same transaction as active binding changes;
 * uncertainty never releases admission merely because a native request returned or timed out.
 */
export const installProjectWorkspaceNativeGuards = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    for (const [name, action, table, projectId] of [
      ["thread_create", "INSERT", "projection_threads", "NEW.project_id"],
      ["thread_reassign", "UPDATE OF project_id", "projection_threads", "NEW.project_id"],
      // Idle-session settlement touches last_used_at while the transition fence is held.
      // Protect project identity/configuration, but do not prevent that settlement timestamp.
      [
        "project_update",
        "UPDATE OF project_id, title, provider_runtime_execution_target_id, workspace_execution_target_id, execution_target_id, workspace_root, workspace_kind, previous_workspace_root, default_model_selection_json, scripts_json, created_at, updated_at, deleting_at, deleted_at",
        "projection_projects",
        "OLD.project_id",
      ],
      ["project_delete", "DELETE", "projection_projects", "OLD.project_id"],
    ] as const) {
      const changed =
        name === "thread_create"
          ? "NOT EXISTS (SELECT 1 FROM projection_threads existing WHERE existing.thread_id = NEW.thread_id)"
          : name === "thread_reassign"
            ? "OLD.project_id IS NOT NEW.project_id"
            : "1";
      const owner =
        name === "thread_reassign"
          ? "native.project_id IN (OLD.project_id, NEW.project_id)"
          : `native.project_id = ${projectId}`;
      yield* sql.unsafe(`CREATE TRIGGER project_workspace_native_${name}
        BEFORE ${action} ON ${table} WHEN ${changed} AND EXISTS (
          SELECT 1 FROM project_workspace_native_operations native
          WHERE ${owner} AND native.phase NOT IN ('committed','rejected'))
        BEGIN SELECT RAISE(ABORT, 'workspace_busy: project transition must settle before changing project ownership'); END`);
    }
    for (const [table, owner, payload, pathField] of [
      ["provider_turn_admissions", "owner_thread_id", "binding_json", "location"],
      ["opencode_v2_shared_bindings", "thread_id", "material_json", "directory"],
      ["muse_session_bindings", "thread_id", "workspace", null],
    ] as const) {
      const safePayload = `CASE WHEN json_valid(NEW.${payload}) THEN NEW.${payload} ELSE '{}' END`;
      const location = pathField
        ? `json_extract(${safePayload}, '$.${pathField}')`
        : `NEW.${payload}`;
      const local = pathField
        ? `COALESCE(json_extract(${safePayload}, '$.workspaceTargetId'),'local') = 'local'`
        : "1";
      const invalid = pathField
        ? `NOT json_valid(NEW.${payload}) OR json_type(${safePayload}, '$.${pathField}') IS NOT 'text'`
        : `NEW.${payload} IS NULL`;
      for (const [suffix, action] of [
        ["insert", "INSERT"],
        ["update", `UPDATE OF ${payload}, ${owner}`],
      ] as const) {
        yield* sql.unsafe(`CREATE TRIGGER project_workspace_native_${table}_${suffix}
        BEFORE ${action} ON ${table} WHEN EXISTS (
          SELECT 1 FROM worktree_operations operation
          JOIN project_workspace_native_operations native USING(operation_id)
          WHERE operation.phase NOT IN ('completed','rejected')
            AND native.phase NOT IN ('committed','rejected')
            AND (EXISTS (SELECT 1 FROM worktree_operation_items item
                  WHERE item.operation_id = operation.operation_id AND item.thread_id = NEW.${owner})
              OR (${local} AND (${invalid}
                OR ${overlap("operation.canonical_path", location)}
                OR ${overlap("operation.destination_path", location)}))))
        BEGIN SELECT RAISE(ABORT, 'workspace_busy: project native transition owns this workspace'); END`);
      }
    }
  });
