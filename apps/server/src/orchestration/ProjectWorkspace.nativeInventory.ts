import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  activeProviderWorkspaceAdmissions,
  effectiveProviderWorkspaceLocation,
} from "../persistence/Layers/ProviderWorkspaceActiveView.ts";
import type { ProjectWorkspaceNativeStep } from "./ProjectWorkspace.nativeRecovery.ts";
import { ThreadId } from "@bigbud/contracts";

export interface WorkspaceNativeOwner {
  readonly provider: "muse" | "opencodeV2";
  readonly threadId: string;
  readonly nativeSessionId: string;
  readonly revision: number;
  readonly storageIdentity: string;
}
export function inventoryProjectWorkspaceNative(
  sql: SqlClient.SqlClient,
  projectId: string,
  source: string,
  destination: string,
) {
  const fail = (detail: string) =>
    new OrchestrationCommandInvariantError({ commandType: "project.reconfigure", detail });
  return Effect.gen(function* () {
    const owners: WorkspaceNativeOwner[] = [];
    const muse = yield* sql<{
      threadId: string;
      nativeSessionId: string;
      revision: number;
      phase: string;
      workspace: string;
      storageIdentity: string;
    }>`
      SELECT binding.thread_id AS "threadId", native_session_id AS "nativeSessionId", revision, phase, workspace, storage_identity AS "storageIdentity"
      FROM muse_session_bindings binding JOIN projection_threads thread USING(thread_id) WHERE thread.project_id = ${projectId}`;
    for (const row of muse) {
      if (row.phase !== "bound" || row.workspace !== source)
        return yield* fail(
          `Muse ownership in thread '${row.threadId}' is uncertain or belongs to another folder. Resolve its binding before reassignment; nothing was transferred.`,
        );
      owners.push({ ...row, provider: "muse" });
    }
    const v2 = yield* sql<{
      threadId: string;
      revision: number;
      state: string;
      material: string;
    }>`SELECT
      binding.thread_id AS "threadId", revision, state, material_json AS material FROM opencode_v2_shared_bindings binding
      JOIN projection_threads thread USING(thread_id) WHERE thread.project_id = ${projectId}`;
    for (const row of v2) {
      const parsed = yield* Effect.try({
        try: () => JSON.parse(row.material) as Record<string, unknown>,
        catch: () =>
          fail(
            `V2 binding in '${row.threadId}' is invalid. Resolve its native ownership before reassignment.`,
          ),
      });
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        row.state !== "verified" ||
        parsed.directory !== source ||
        parsed.runtimeTargetId !== "local" ||
        parsed.workspaceTargetId !== "local" ||
        typeof parsed.nativeSessionId !== "string" ||
        typeof parsed.storageIdentity !== "string"
      )
        return yield* fail(
          `V2 binding in '${row.threadId}' is uncertain or not owned at the source. Nothing was transferred.`,
        );
      owners.push({
        provider: "opencodeV2",
        threadId: row.threadId,
        nativeSessionId: parsed.nativeSessionId,
        storageIdentity: parsed.storageIdentity,
        revision: row.revision,
      });
    }
    const active = yield* activeProviderWorkspaceAdmissions(sql);
    const admissions = yield* sql<{
      binding: string;
      state: string;
    }>`SELECT binding_json AS binding, state FROM provider_turn_admissions
      WHERE CASE WHEN json_valid(binding_json) THEN json_extract(binding_json, '$.threadId') END IN
        (SELECT thread_id FROM projection_threads WHERE project_id = ${projectId}) ${active}`;
    for (const admission of admissions) {
      const value = yield* Effect.try({
        try: () => JSON.parse(admission.binding) as Record<string, unknown>,
        catch: () =>
          fail("Native admission recovery evidence is invalid. Nothing was transferred."),
      });
      if (!value || typeof value !== "object" || Array.isArray(value))
        return yield* fail(
          "Native admission recovery evidence is invalid. Nothing was transferred.",
        );
      if (value.provider !== "muse" && value.provider !== "opencodeV2") continue;
      if (admission.state !== "terminal")
        return yield* fail(
          "Native admission work is unresolved. Settle all native turns before changing folders.",
        );
      const owner = owners.find(
        (candidate) =>
          candidate.provider === value.provider &&
          candidate.threadId === value.threadId &&
          (candidate.provider === "muse" ||
            (candidate.nativeSessionId === value.nativeSessionId &&
              candidate.storageIdentity === value.storageIdentity)),
      );
      if (!owner)
        return yield* fail(
          `Retained ${String(value.provider)} history has no matching active native owner. Recover that binding before changing folders; history was not discarded.`,
        );
      if (owner.provider === "opencodeV2") {
        const location = yield* effectiveProviderWorkspaceLocation(sql, {
          provider: owner.provider,
          threadId: ThreadId.makeUnsafe(owner.threadId),
          nativeSessionId: owner.nativeSessionId,
          storageIdentity: owner.storageIdentity,
          location: String(value.location),
          runtimeTargetId: String(value.runtimeTargetId),
          workspaceTargetId: String(value.workspaceTargetId),
        });
        if (location !== source)
          return yield* fail(
            "Retained V2 history has a different effective Location. Resolve its lineage before reassignment.",
          );
      }
    }
    const steps: ProjectWorkspaceNativeStep[] = owners.map((owner) =>
      owner.provider === "muse"
        ? {
            provider: "muse",
            threadId: owner.threadId,
            nativeSessionId: owner.nativeSessionId,
            phase: "archive-ready",
          }
        : {
            provider: "opencodeV2",
            threadId: owner.threadId,
            nativeSessionId: owner.nativeSessionId,
            storageIdentity: owner.storageIdentity,
            sourceDirectory: source,
            destinationDirectory: destination,
            phase: "prepared",
          },
    );
    return { owners, steps };
  });
}
