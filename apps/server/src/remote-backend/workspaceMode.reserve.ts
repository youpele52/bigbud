import {
  decideReservation,
  encodeWorkspaceModeRecord,
  type WorkspaceModeRecord,
  type WorkspaceModeStore,
  type WorkspaceRuntimeMode,
} from "./workspaceMode.record.ts";

const MAX_ATTEMPTS = 8;

export type ReservationOutcome =
  | { readonly kind: "unsupported"; readonly reason: string }
  | { readonly kind: "reserved"; readonly record: WorkspaceModeRecord }
  | { readonly kind: "conflict"; readonly holder: WorkspaceModeRecord };

/** A lost reply does not undo an exclusive create: reconcile by content before failing. */
export async function publishReconciled(
  store: WorkspaceModeStore,
  workspaceRoot: string,
  next: WorkspaceModeRecord,
): Promise<"committed" | "conflict"> {
  try {
    return await store.publish(next);
  } catch (cause) {
    const observed = await store.inspect(workspaceRoot).catch(() => undefined);
    if (
      observed?.kind === "ready" &&
      observed.current !== null &&
      encodeWorkspaceModeRecord(observed.current) === encodeWorkspaceModeRecord(next)
    )
      return "committed";
    throw cause;
  }
}

/** Reserve or confirm `mode` for the folder; lost races re-read and decide again. */
export async function reserveWorkspaceMode(
  store: WorkspaceModeStore,
  workspaceRoot: string,
  mode: WorkspaceRuntimeMode,
  owner: string,
): Promise<ReservationOutcome> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const inspection = await store.inspect(workspaceRoot);
    if (inspection.kind === "unsupported") return inspection;
    const decision = decideReservation(inspection.identity, inspection.current, mode, owner);
    if (decision.kind === "held") return { kind: "reserved", record: decision.record };
    if (decision.kind === "conflict") return decision;
    if ((await publishReconciled(store, workspaceRoot, decision.next)) === "committed")
      return { kind: "reserved", record: decision.next };
  }
  throw new Error("Workspace mode reservation contention exceeded the retry budget.");
}
