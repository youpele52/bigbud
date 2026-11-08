import { Effect } from "effect";
import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { ProviderTurnAdmissionBinding } from "@bigbud/contracts/orchestration/providerTurnAdmission.ts";
import type { ProviderTurnAdmissionsShape } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { decodeV2Cursor } from "./Runtime.cursor.ts";
import type { V2StartInput } from "./Runtime.types.ts";

/** Derivation only: the stored admission/cursor is never rewritten to manufacture a resume. */
export async function effectiveV2WorkspaceLocation(
  journal: ProviderTurnAdmissionsShape,
  binding: ProviderTurnAdmissionBinding,
) {
  return journal.effectiveWorkspaceLocation
    ? Effect.runPromise(journal.effectiveWorkspaceLocation(binding))
    : binding.location;
}

export async function effectiveV2WorkspaceCursor(
  journal: ProviderTurnAdmissionsShape,
  cursor: ReturnType<typeof decodeV2Cursor> | undefined,
  owner: {
    readonly threadId: ThreadId;
    readonly runtimeTarget: string;
    readonly workspaceTarget: string;
  },
) {
  if (!cursor) return undefined;
  const directory = await effectiveV2WorkspaceLocation(journal, {
    provider: "opencodeV2",
    threadId: owner.threadId,
    nativeSessionId: cursor.nativeSessionId,
    storageIdentity: cursor.storageIdentity,
    location: cursor.directory,
    runtimeTargetId: owner.runtimeTarget,
    workspaceTargetId: owner.workspaceTarget,
  });
  return { ...cursor, directory };
}

/** Keep native/storage/target fencing unchanged while resolving explicitly verified Location history. */
export async function assertV2RetainedWorkspace(
  journal: ProviderTurnAdmissionsShape,
  input: V2StartInput,
  binding: {
    readonly nativeSessionId: string;
    readonly storageIdentity: string;
    readonly directory: string;
    readonly runtimeTarget: string;
    readonly workspaceTarget: string;
  },
  connectionMode: "shared" | "isolated",
) {
  const retained = await Effect.runPromise(journal.latestBound(input.threadId));
  if (
    retained &&
    (retained.binding.storageIdentity !== binding.storageIdentity ||
      retained.binding.nativeSessionId !== binding.nativeSessionId ||
      (await effectiveV2WorkspaceLocation(journal, retained.binding)) !== binding.directory ||
      retained.binding.runtimeTargetId !== binding.runtimeTarget ||
      retained.binding.workspaceTargetId !== binding.workspaceTarget)
  ) {
    throw new Error(
      "V2 retained admission belongs to another native storage/target. Existing history is read-only here; no session was created, rebound or replayed.",
    );
  }
  const cursor = await effectiveV2WorkspaceCursor(
    journal,
    input.resumeCursor === undefined ? undefined : decodeV2Cursor(input.resumeCursor),
    {
      threadId: input.threadId,
      runtimeTarget: binding.runtimeTarget,
      workspaceTarget: binding.workspaceTarget,
    },
  );
  if (
    cursor &&
    (cursor.nativeSessionId !== binding.nativeSessionId ||
      cursor.storageIdentity !== binding.storageIdentity ||
      cursor.directory !== binding.directory ||
      (cursor.connectionMode !== undefined && cursor.connectionMode !== connectionMode))
  ) {
    throw new Error("V2 resume ownership mismatch; no fresh-session fallback.");
  }
  return { cursor, retained };
}
