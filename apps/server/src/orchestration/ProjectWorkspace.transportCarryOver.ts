import path from "node:path";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { OrchestrationCommand, OrchestrationReadModel } from "@bigbud/contracts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { isTransportOnlyTargetChange } from "../ssh/sshExecutionTarget.transport.ts";
import { v2RemoteLocationCandidates } from "../provider/Layers/OpencodeV2/Application.remoteLocation.ts";

type TargetPair = { readonly previous: string; readonly next: string };
export interface ProjectTransportChange {
  readonly workspace?: TargetPair;
  readonly runtime?: TargetPair;
}

/**
 * A reconfigure that keeps the folder and changes only how bigbud connects to the same SSH host.
 * Returns undefined for any other change (or no target change), which keeps today's rules.
 */
export function projectTransportOnlyChange(
  command: OrchestrationCommand,
  readModel: OrchestrationReadModel,
): ProjectTransportChange | undefined {
  if (command.type !== "project.reconfigure") return undefined;
  const project = readModel.projects.find((entry) => entry.id === command.projectId);
  if (!project || project.workspaceRoot !== command.workspaceRoot) return undefined;
  const pair = (previous: string | null | undefined, next: string) => {
    if (previous === next) return { same: true } as const;
    return isTransportOnlyTargetChange(previous, next)
      ? ({ same: false, pair: { previous: previous!, next } } as const)
      : undefined;
  };
  const workspace = pair(
    project.workspaceExecutionTargetId ?? project.executionTargetId,
    command.workspaceExecutionTargetId,
  );
  const runtime = pair(
    project.providerRuntimeExecutionTargetId ?? project.executionTargetId,
    command.providerRuntimeExecutionTargetId,
  );
  if (!workspace || !runtime || (workspace.same && runtime.same)) return undefined;
  return {
    ...(workspace.same ? {} : { workspace: workspace.pair }),
    ...(runtime.same ? {} : { runtime: runtime.pair }),
  };
}

/** Only OpenCode V2 history moves with a transport switch; Muse never runs on remote targets. */
export const transportCarryOverBlocker = Effect.fn("transportCarryOverBlocker")(function* (
  sql: SqlClient.SqlClient,
  threadId: string,
) {
  const muse = yield* sql`SELECT 1 FROM muse_session_bindings WHERE thread_id = ${threadId}
    UNION ALL SELECT 1 FROM provider_session_runtime WHERE thread_id = ${threadId} AND provider_name = 'muse'
    UNION ALL SELECT 1 FROM provider_turn_admissions WHERE owner_thread_id = ${threadId}
      AND json_extract(CASE WHEN json_valid(binding_json) THEN binding_json ELSE '{}' END, '$.provider') = 'muse' LIMIT 1`;
  if (muse.length) return "native";
  const live = yield* sql`SELECT 1 FROM provider_session_runtime WHERE thread_id = ${threadId}
    AND provider_name = 'opencodeV2' AND status IN ('starting','running') LIMIT 1`;
  return live.length ? "live" : undefined;
});

type TargetKind = "runtime" | "workspace" | "either";

/** Pure: undefined when any populated target belongs to neither side of the switch. */
export function retargetRecord(
  record: Record<string, unknown>,
  fields: Readonly<Record<string, TargetKind>>,
  change: ProjectTransportChange,
): Record<string, unknown> | undefined {
  const next = { ...record };
  for (const [field, kind] of Object.entries(fields)) {
    const value = record[field];
    if (value === undefined || value === null) continue;
    const pairs = [
      ...(kind !== "workspace" && change.runtime ? [change.runtime] : []),
      ...(kind !== "runtime" && change.workspace ? [change.workspace] : []),
    ];
    const match = pairs.find((pair) => pair.previous === value);
    if (match) next[field] = match.next;
    else if (kind !== "either" && pairs.length && !pairs.some((pair) => pair.next === value))
      return undefined;
  }
  return next;
}

const BINDING_FIELDS = { runtimeTargetId: "runtime", workspaceTargetId: "workspace" } as const;
const PAYLOAD_FIELDS = {
  providerRuntimeExecutionTargetId: "runtime",
  workspaceExecutionTargetId: "workspace",
  executionTargetId: "either",
} as const;

/**
 * Rebinds retained OpenCode V2 history to the new transport inside the project commit
 * transaction. Native session, storage identity and Location stay byte-identical; only the
 * target IDs change, each row guarded by its exact prior content (and revision for bindings).
 */
export const carryTransportOnlyBindings = Effect.fn("carryTransportOnlyBindings")(function* (
  sql: SqlClient.SqlClient,
  command: OrchestrationCommand,
  readModel: OrchestrationReadModel,
) {
  const change = projectTransportOnlyChange(command, readModel);
  if (!change || command.type !== "project.reconfigure") return;
  const fail = (detail: string) =>
    new OrchestrationCommandInvariantError({ commandType: command.type, detail });
  const threads = yield* sql<{ threadId: string }>`SELECT thread_id AS "threadId"
    FROM projection_threads WHERE project_id = ${command.projectId}`;
  // Pass 1, before any write: every retained Location must be one the resolver will find for
  // the new target, or the rebound thread would get a fresh native Location and lose history.
  for (const { threadId } of threads) {
    const unreachable = yield* unreachableV2Locations(sql, threadId, command.workspaceRoot, change);
    if (unreachable)
      return yield* fail(
        `Thread '${threadId}' keeps OpenCode history in a Location the new connection cannot resolve. Nothing was changed; keep the current connection.`,
      );
  }
  for (const { threadId } of threads) {
    const unreadable = fail(
      `Thread '${threadId}' retains OpenCode history that cannot be rebound to this connection. Nothing was changed.`,
    );
    const retarget = (json: string, fields: Readonly<Record<string, TargetKind>>) =>
      Effect.try({
        try: () => JSON.parse(json) as Record<string, unknown>,
        catch: () => unreadable,
      }).pipe(
        Effect.flatMap((record) => {
          const next =
            record && typeof record === "object"
              ? retargetRecord(record, fields, change)
              : undefined;
          return next ? Effect.succeed(JSON.stringify(next)) : Effect.fail(unreadable);
        }),
      );
    const bindings = yield* sql<{ materialJson: string; revision: number }>`SELECT
      material_json AS "materialJson", revision FROM opencode_v2_shared_bindings WHERE thread_id = ${threadId}`;
    for (const row of bindings) {
      const material = yield* retarget(row.materialJson, BINDING_FIELDS);
      const updated = yield* sql`UPDATE opencode_v2_shared_bindings
        SET material_json = ${material}, revision = revision + 1
        WHERE thread_id = ${threadId} AND revision = ${row.revision}
          AND material_json = ${row.materialJson} RETURNING revision`;
      if (!updated.length)
        return yield* fail(`Thread '${threadId}' OpenCode binding changed. Retry the save.`);
    }
    const admissions = yield* sql<{ requestMessageId: string; bindingJson: string; state: string }>`
      SELECT request_message_id AS "requestMessageId", binding_json AS "bindingJson", state
      FROM provider_turn_admissions WHERE owner_thread_id = ${threadId}
        AND json_extract(CASE WHEN json_valid(binding_json) THEN binding_json ELSE '{}' END, '$.provider') = 'opencodeV2'`;
    for (const row of admissions) {
      if (row.state !== "terminal")
        return yield* fail(
          `Stop execution in thread '${threadId}' before switching its connection.`,
        );
      const binding = yield* retarget(row.bindingJson, BINDING_FIELDS);
      const updated = yield* sql`UPDATE provider_turn_admissions SET binding_json = ${binding}
        WHERE owner_thread_id = ${threadId} AND request_message_id = ${row.requestMessageId}
          AND state = 'terminal' AND binding_json = ${row.bindingJson} RETURNING state`;
      if (!updated.length)
        return yield* fail(`Thread '${threadId}' OpenCode turn history changed. Retry the save.`);
    }
    const runtimes = yield* sql<{
      status: string;
      columns: string;
      payload: string | null;
      runtimeTarget: string;
      workspaceTarget: string;
      executionTarget: string;
    }>`
      SELECT status, provider_runtime_execution_target_id AS "runtimeTarget",
        workspace_execution_target_id AS "workspaceTarget", execution_target_id AS "executionTarget", runtime_payload_json AS "payload", json_object(
        'providerRuntimeExecutionTargetId', provider_runtime_execution_target_id,
        'workspaceExecutionTargetId', workspace_execution_target_id,
        'executionTargetId', execution_target_id) AS "columns"
      FROM provider_session_runtime WHERE thread_id = ${threadId} AND provider_name = 'opencodeV2'`;
    for (const row of runtimes) {
      if (row.status === "starting" || row.status === "running")
        return yield* fail(
          `Stop the OpenCode session in thread '${threadId}' before switching its connection.`,
        );
      const columns = JSON.parse(yield* retarget(row.columns, PAYLOAD_FIELDS)) as Record<
        string,
        string | null
      >;
      const payload = row.payload ? yield* retarget(row.payload, PAYLOAD_FIELDS) : null;
      const updated = yield* sql`UPDATE provider_session_runtime
        SET provider_runtime_execution_target_id = ${columns.providerRuntimeExecutionTargetId ?? null},
          workspace_execution_target_id = ${columns.workspaceExecutionTargetId ?? null},
          execution_target_id = ${columns.executionTargetId ?? null},
          runtime_payload_json = ${payload}
        WHERE thread_id = ${threadId} AND provider_name = 'opencodeV2'
          AND status NOT IN ('starting','running')
          AND provider_runtime_execution_target_id = ${row.runtimeTarget}
          AND workspace_execution_target_id = ${row.workspaceTarget}
          AND execution_target_id = ${row.executionTarget}
          AND runtime_payload_json IS ${row.payload} RETURNING status`;
      if (updated.length !== 1)
        return yield* fail(`Thread '${threadId}' OpenCode session changed. Retry the save.`);
    }
  }
});

const LOCATION_ROOT = "opencode-v2-remote-workspaces";

/** Undefined when the new target/root cannot hold a remote Location at all. */
function locationCandidates(threadId: string, target: string, workspaceRoot: string | null) {
  try {
    return v2RemoteLocationCandidates(threadId, target, workspaceRoot ?? "");
  } catch {
    return undefined;
  }
}

/**
 * True when a retained binding, admission or cursor Location is not among the identities the
 * resolver tries for the new workspace target (exact, then each transport/legacy form).
 */
const unreachableV2Locations = Effect.fn("unreachableV2Locations")(function* (
  sql: SqlClient.SqlClient,
  threadId: string,
  workspaceRoot: string | null,
  change: ProjectTransportChange,
) {
  if (!change.workspace) return false;
  const rows = yield* sql<{ location: string | null }>`
    SELECT json_extract(material_json, '$.directory') AS "location"
      FROM opencode_v2_shared_bindings WHERE thread_id = ${threadId} AND json_valid(material_json)
    UNION ALL SELECT json_extract(binding_json, '$.location') FROM provider_turn_admissions
      WHERE owner_thread_id = ${threadId} AND json_valid(binding_json)
        AND json_extract(binding_json, '$.provider') = 'opencodeV2'
    UNION ALL SELECT json_extract(resume_cursor_json, '$.directory') FROM provider_session_runtime
      WHERE thread_id = ${threadId} AND provider_name = 'opencodeV2' AND json_valid(resume_cursor_json)`;
  if (!rows.length) return false;
  const candidates = locationCandidates(threadId, change.workspace.next, workspaceRoot);
  if (!candidates) return true;
  return rows.some(
    ({ location }) =>
      typeof location !== "string" ||
      path.basename(path.dirname(location)) !== LOCATION_ROOT ||
      !candidates.includes(path.basename(location)),
  );
});
