import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { recordedWorktreePathsOverlap } from "../../deletion/Layers/ThreadDeletion.worktreePaths.ts";
import { worktreeFailure } from "./WorktreeInventory.ts";
import type { WorktreePathResolver } from "./WorktreeReferences.ts";

export interface RetainedWorktreeProviderContext {
  readonly kind: "runtime" | "admission" | "shared";
  readonly owner: string;
  readonly location: string;
  readonly canonicalLocation: string;
  readonly provider: string | undefined;
}

/** Exhaust every retained owner, including orphaned native rows and historical admissions; never truncate discovery. */
export function listRetainedWorktreeProviderContexts(
  sql: SqlClient.SqlClient,
  target: string,
  resolve: WorktreePathResolver,
) {
  return Effect.gen(function* () {
    const canonicalTarget = yield* resolve(target);
    const contexts: RetainedWorktreeProviderContext[] = [];
    let afterKind = "",
      afterId = 0;
    while (true) {
      const page = yield* sql<{
        readonly kind: RetainedWorktreeProviderContext["kind"];
        readonly id: number;
        readonly owner: string;
        readonly provider: string | null;
        readonly material: string | null;
        readonly target: string | null;
      }>`
        SELECT * FROM (
          SELECT 'runtime' AS kind,rowid AS id,thread_id AS owner,provider_name AS provider,
            runtime_payload_json AS material,workspace_execution_target_id AS target
            FROM provider_session_runtime WHERE resume_cursor_json IS NOT NULL OR provider_name IN ('opencodeV2','opencode')
          UNION ALL SELECT 'admission',rowid,owner_thread_id,NULL,binding_json,NULL FROM provider_turn_admissions
          UNION ALL SELECT 'shared',rowid,thread_id,'opencodeV2',material_json,NULL FROM opencode_v2_shared_bindings
        ) WHERE kind > ${afterKind} OR (kind = ${afterKind} AND id > ${afterId}) ORDER BY kind,id LIMIT 100`;
      for (const row of page) {
        const record = yield* Effect.try({
          try: () => {
            const value: unknown = row.material === null ? null : JSON.parse(row.material);
            if (!value || typeof value !== "object" || Array.isArray(value))
              throw new Error("Invalid native material");
            const material = value as Record<string, unknown>;
            const workspace = row.target ?? material.workspaceTargetId ?? "local";
            if (typeof workspace !== "string") throw new Error("Unknown native target");
            if (workspace !== "local") return undefined;
            const location =
              row.kind === "runtime"
                ? material.cwd
                : row.kind === "admission"
                  ? material.location
                  : material.directory;
            if (typeof location !== "string" || !location)
              throw new Error("Unknown native location");
            return { material, location };
          },
          catch: () =>
            worktreeFailure(
              target,
              `Retained provider location could not be verified (${row.kind} owner ${row.owner}); no native evidence was discarded.`,
            ),
        });
        if (!record) continue;
        const canonicalLocation = yield* resolve(record.location);
        if (!recordedWorktreePathsOverlap(canonicalLocation, canonicalTarget)) continue;
        const material = record.material;
        contexts.push({
          kind: row.kind,
          owner: row.owner,
          location: record.location,
          canonicalLocation,
          provider:
            typeof material.provider === "string" ? material.provider : (row.provider ?? undefined),
        });
      }
      if (page.length < 100) break;
      afterKind = page.at(-1)!.kind;
      afterId = page.at(-1)!.id;
    }
    return contexts;
  });
}
