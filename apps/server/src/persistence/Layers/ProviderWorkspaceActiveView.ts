import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { toPersistenceSqlError } from "../Errors.ts";
import type { ProviderTurnAdmissionBinding } from "@bigbud/contracts/orchestration/providerTurnAdmission.ts";
import { ProviderTurnAdmissionConflict } from "../Services/ProviderTurnAdmissions.ts";

// Migration147 is deliberately unregistered until146 lands. Legacy schemas have no archives;
// native transition coordination must require147 before it can create any reset operation.
const hasArchives = (sql: SqlClient.SqlClient) =>
  sql`SELECT 1 FROM sqlite_master
  WHERE type = 'table' AND name = 'provider_workspace_binding_archives'`.pipe(
    Effect.map((rows) => rows.length !== 0),
    Effect.mapError(toPersistenceSqlError("workspace.activeView.schema")),
  );

/** Only active attachment/recovery scans use this filter. Exact request lookup and immutable
 * replay/fingerprint evidence remain available, including archived historical admissions.
 */
export const activeProviderWorkspaceAdmissions = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    if (!(yield* hasArchives(sql))) return sql``;
    return sql`AND NOT EXISTS (
    SELECT 1 FROM provider_workspace_archived_admissions archived
    JOIN provider_workspace_binding_archives recovery USING(archive_id)
    WHERE recovery.provider = 'muse'
      AND archived.namespace = provider_turn_admissions.namespace
      AND archived.owner_thread_id = provider_turn_admissions.owner_thread_id
      AND archived.request_message_id = provider_turn_admissions.request_message_id)`;
  });

/** Application commit sequence orders repeated moves, including returning to an earlier folder.
 * Only an exact retained native/storage/thread owner can follow immutable verified lineage.
 */
export const effectiveProviderWorkspaceLocation = (
  sql: SqlClient.SqlClient,
  binding: ProviderTurnAdmissionBinding,
) =>
  Effect.gen(function* () {
    if (binding.provider !== "opencodeV2" || !(yield* hasArchives(sql))) return binding.location;
    const rows = yield* sql<{ oldLocation: string; newLocation: string }>`
    SELECT lineage.old_location AS "oldLocation", lineage.new_location AS "newLocation"
    FROM provider_workspace_location_lineage lineage
    JOIN project_workspace_native_operations native USING(operation_id)
    WHERE lineage.provider = 'opencodeV2' AND lineage.thread_id = ${binding.threadId}
      AND lineage.native_session_id = ${binding.nativeSessionId} AND lineage.storage_identity = ${binding.storageIdentity}
      AND native.phase = 'committed' AND native.result_sequence IS NOT NULL
    ORDER BY native.result_sequence LIMIT 1001`.pipe(
      Effect.mapError(toPersistenceSqlError("workspace.activeView.lineage")),
    );
    if (!rows.length) return binding.location;
    let previous: string | undefined;
    let known = false;
    for (const row of rows) {
      if (
        !row.oldLocation ||
        !row.newLocation ||
        row.oldLocation === row.newLocation ||
        (previous !== undefined && row.oldLocation !== previous)
      ) {
        return yield* new ProviderTurnAdmissionConflict({
          detail: "Verified V2 workspace lineage is inconsistent; no native replacement or replay.",
        });
      }
      known ||= binding.location === row.oldLocation || binding.location === row.newLocation;
      previous = row.newLocation;
    }
    if (
      !known ||
      rows.length > 1000 ||
      binding.runtimeTargetId !== "local" ||
      binding.workspaceTargetId !== "local"
    ) {
      return yield* new ProviderTurnAdmissionConflict({
        detail:
          "Retained V2 workspace ownership does not match verified lineage; recovery is required.",
      });
    }
    return previous!;
  });

export const isArchivedMuseWorkspaceNative = (
  sql: SqlClient.SqlClient,
  threadId: string,
  nativeSessionId: string,
) =>
  Effect.gen(function* () {
    if (!(yield* hasArchives(sql))) return false;
    const rows = yield* sql`SELECT 1 FROM provider_workspace_binding_archives
    WHERE provider = 'muse' AND thread_id = ${threadId} AND native_session_id = ${nativeSessionId} LIMIT 1`.pipe(
      Effect.mapError(toPersistenceSqlError("workspace.activeView.archivedMuse")),
    );
    return rows.length !== 0;
  });
