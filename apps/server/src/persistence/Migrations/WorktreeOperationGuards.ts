import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

const normalize = (value: string) =>
  process.platform === "win32" ? `lower(replace(${value}, char(92), '/'))` : value;

function overlap(left: string, right: string): string {
  const a = normalize(left),
    b = normalize(right);
  return `(${a} = ${b} OR substr(${a}, 1, length(${b}) + 1) = ${b} || '/' OR substr(${b}, 1, length(${a}) + 1) = ${a} || '/')`;
}

/** Install the same admission guards for fresh and already-applied development schemas. */
export const installWorktreeOperationGuards = Effect.fn("installWorktreeOperationGuards")(
  function* (sql: SqlClient.SqlClient) {
    const execute = (name: string, definition: string) =>
      sql
        .unsafe(`DROP TRIGGER IF EXISTS ${name}`)
        .pipe(Effect.andThen(sql.unsafe(`CREATE TRIGGER ${name} ${definition}`)));
    const conflict = (target: string, device: string, inode: string, runtime = false) => `EXISTS (
      SELECT 1 FROM worktree_operations AS operation
      WHERE operation.phase NOT IN ('completed','rejected') ${runtime ? "AND (operation.kind <> 'access' OR operation.branch = 'workspace-mutation')" : ""} AND (
        ${overlap("operation.canonical_path", target)} OR
        ${overlap("operation.destination_path", target)} OR
        (operation.device = ${device} AND operation.inode = ${inode})
        ${runtime ? "OR EXISTS (SELECT 1 FROM worktree_operation_items item WHERE item.operation_id = operation.operation_id AND item.thread_id = NEW.thread_id)" : ""}
      ))`;
    for (const [suffix, on] of [
      ["insert", "INSERT"],
      ["update", "UPDATE OF canonical_path, device, inode"],
    ] as const) {
      yield* execute(
        `worktree_operation_runtime_${suffix}`,
        `BEFORE ${on} ON worktree_runtime_leases
        WHEN ${conflict("NEW.canonical_path", "NEW.device", "NEW.inode", true)}
        BEGIN SELECT RAISE(ABORT, 'workspace_busy: worktree operation owns this workspace'); END`,
      );
    }
    yield* execute(
      "worktree_operation_cleanup_insert",
      `BEFORE INSERT ON purge_resource_claims
      WHEN NEW.resource_kind = 'managed-worktree' AND ${conflict("NEW.canonical_path", "NEW.device", "NEW.inode")}
      BEGIN SELECT RAISE(ABORT, 'workspace_busy: worktree operation owns this workspace'); END`,
    );
    yield* execute(
      "worktree_operation_direct_cleanup_insert",
      `BEFORE INSERT ON direct_resource_cleanup_worktrees
      WHEN ${conflict("json_extract(NEW.resource_json, '$.identity.canonicalPath')", "json_extract(NEW.resource_json, '$.identity.device')", "json_extract(NEW.resource_json, '$.identity.inode')")}
      BEGIN SELECT RAISE(ABORT, 'workspace_busy: direct cleanup conflicts with worktree operation'); END`,
    );
    yield* execute(
      "worktree_operation_activity_insert",
      `BEFORE INSERT ON thread_activity_leases WHEN EXISTS (
      SELECT 1 FROM worktree_operations AS operation
      JOIN projection_threads AS thread ON thread.thread_id = NEW.thread_id
      JOIN projection_projects AS project ON project.project_id = thread.project_id
      WHERE operation.phase NOT IN ('completed','rejected')
        AND (operation.kind <> 'access' OR operation.branch = 'workspace-mutation')
        AND thread.workspace_execution_target_id = 'local' AND (
          ${overlap("operation.canonical_path", "COALESCE(thread.worktree_canonical_path,thread.worktree_path,project.workspace_root)")} OR
          ${overlap("operation.destination_path", "COALESCE(thread.worktree_canonical_path,thread.worktree_path,project.workspace_root)")} OR
          (operation.device = thread.worktree_device AND operation.inode = thread.worktree_inode)))
      BEGIN SELECT RAISE(ABORT, 'workspace_busy: activity admission conflicts with worktree operation'); END`,
    );
    for (const [table, payload, location, target, owner] of [
      [
        "provider_turn_admissions",
        "binding_json",
        "location",
        "workspaceTargetId",
        "owner_thread_id",
      ],
      [
        "opencode_v2_shared_bindings",
        "material_json",
        "directory",
        "workspaceTargetId",
        "thread_id",
      ],
    ] as const) {
      const safePayload = `CASE WHEN json_valid(NEW.${payload}) THEN NEW.${payload} ELSE '{}' END`;
      for (const [suffix, on] of [
        ["insert", "INSERT"],
        ["update", `UPDATE OF ${payload}, ${owner}`],
      ] as const) {
        yield* execute(
          `worktree_operation_${table}_${suffix}`,
          `BEFORE ${on} ON ${table}
          WHEN EXISTS (SELECT 1 FROM worktree_operations AS operation
            WHERE operation.phase NOT IN ('completed','rejected') AND operation.kind <> 'access' AND (
              NOT json_valid(NEW.${payload}) OR (
              COALESCE(json_extract(${safePayload}, '$.${target}'),'local') = 'local' AND (
              json_type(${safePayload}, '$.${location}') IS NOT 'text' OR
              ${overlap("operation.canonical_path", `json_extract(${safePayload}, '$.${location}')`)} OR
              ${overlap("operation.destination_path", `json_extract(${safePayload}, '$.${location}')`)} OR
              EXISTS (SELECT 1 FROM worktree_operation_items item WHERE item.operation_id = operation.operation_id AND item.thread_id = NEW.${owner})
            ))))
          BEGIN SELECT RAISE(ABORT, 'workspace_busy: native admission conflicts with worktree operation'); END`,
        );
      }
    }
    for (const [suffix, on] of [
      ["insert", "INSERT"],
      ["update", "UPDATE OF status, runtime_payload_json"],
    ] as const) {
      yield* execute(
        `worktree_operation_provider_${suffix}`,
        `BEFORE ${on} ON provider_session_runtime
        WHEN NEW.workspace_execution_target_id = 'local' AND NEW.status IN ('starting','running')
          AND EXISTS (SELECT 1 FROM worktree_operations AS operation
            WHERE operation.phase NOT IN ('completed','rejected') AND (operation.kind <> 'access' OR operation.branch = 'workspace-mutation') AND (
              EXISTS (SELECT 1 FROM worktree_operation_items item WHERE item.operation_id = operation.operation_id AND item.thread_id = NEW.thread_id) OR
              ${overlap("operation.canonical_path", "json_extract(NEW.runtime_payload_json, '$.cwd')")} OR
              ${overlap("operation.destination_path", "json_extract(NEW.runtime_payload_json, '$.cwd')")}
            ))
        BEGIN SELECT RAISE(ABORT, 'workspace_busy: provider runtime conflicts with worktree operation'); END`,
      );
    }
  },
);
