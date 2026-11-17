/**
 * Explicit workspace-mode conversion (decision 8): requested by a backend that currently holds
 * the folder's mode, only while that backend runs no turns or terminals for it. Conversion moves
 * no history: the old backend's projects and threads stay where they are (and are refused by the
 * reservation from then on); the new mode's backend starts its own projects. The converted record
 * has no owner until the first backend of the new mode claims it.
 *
 * @module workspaceMode.conversion
 */
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { OrchestrationReadModel } from "@bigbud/contracts";

import type { TerminalManagerShape } from "../terminal/Services/Manager.ts";
import { findWorkspaceBusyReason } from "./workspaceMode.busy.ts";
import type { WorkspaceModeGateShape } from "./workspaceMode.gate.ts";
import type {
  WorkspaceModeRecord,
  WorkspaceModeStore,
  WorkspaceRuntimeMode,
} from "./workspaceMode.record.ts";
import { publishReconciled } from "./workspaceMode.reserve.ts";

export type WorkspaceBusyProbe = () => Promise<
  { readonly busy: false } | { readonly busy: true; readonly reason: string }
>;

export type WorkspaceModeConversionOutcome =
  | { readonly kind: "converted"; readonly record: WorkspaceModeRecord }
  | { readonly kind: "already"; readonly record: WorkspaceModeRecord }
  | { readonly kind: "refused"; readonly reason: string };

const modeLabel = (mode: WorkspaceRuntimeMode) =>
  mode === "laptop-runtime"
    ? "laptop-runtime (a laptop backend over SSH)"
    : "remote-runtime (the backend on the host)";

export async function convertWorkspaceMode(input: {
  readonly store: WorkspaceModeStore;
  readonly workspaceRoot: string;
  /** The mode this backend uses the folder in: it must be the mode currently reserved. */
  readonly requesterMode: WorkspaceRuntimeMode;
  readonly targetMode: WorkspaceRuntimeMode;
  readonly isBusy: WorkspaceBusyProbe;
}): Promise<WorkspaceModeConversionOutcome> {
  const inspection = await input.store.inspect(input.workspaceRoot);
  if (inspection.kind === "unsupported")
    return {
      kind: "refused",
      reason: `This host cannot hold workspace mode reservations (${inspection.reason}).`,
    };
  const current = inspection.current;
  if (current?.mode === input.targetMode) return { kind: "already", record: current };
  if (current !== null && current.mode !== input.requesterMode)
    return {
      kind: "refused",
      reason: `Only the backend that uses this folder in ${modeLabel(current.mode)} mode can convert it.`,
    };
  const busy = await input.isBusy();
  if (busy.busy)
    return {
      kind: "refused",
      reason: `Conversion needs this folder to be idle: ${busy.reason} Stop running turns and close terminals for it, then retry.`,
    };
  const next: WorkspaceModeRecord = {
    ...inspection.identity,
    generation: (current?.generation ?? 0) + 1,
    mode: input.targetMode,
    owner: null,
  };
  // No retry: a concurrent change means the decision was made on stale state.
  return (await publishReconciled(input.store, input.workspaceRoot, next)) === "committed"
    ? { kind: "converted", record: next }
    : {
        kind: "refused",
        reason:
          "The folder's workspace mode changed while converting. Review its current mode and retry.",
      };
}

/**
 * Backend entry point: converts a folder this backend uses, checking every local project whose
 * folder resolves (on the workspace host) to the same real path, so aliases cannot hide work.
 */
export const convertBackendWorkspaceMode = Effect.fn("convertBackendWorkspaceMode")(
  function* (input: {
    readonly gate: WorkspaceModeGateShape;
    readonly sql: SqlClient.SqlClient;
    readonly terminal: TerminalManagerShape | undefined;
    readonly readModel: OrchestrationReadModel;
    readonly executionTargetId: string;
    readonly workspaceRoot: string;
    readonly targetMode: WorkspaceRuntimeMode;
  }) {
    const resolved = input.gate.resolve(input.executionTargetId);
    if (!resolved)
      return {
        kind: "refused",
        reason: "This backend does not reserve workspace modes for that folder.",
      } as const;
    const { store } = resolved;
    const realpathOf = async (root: string) => {
      const inspection = await store.inspect(root).catch(() => undefined);
      return inspection?.kind === "ready" ? inspection.identity.realpathSha256 : undefined;
    };
    const services = yield* Effect.services<never>();
    const outcome = yield* Effect.tryPromise({
      try: async () => {
        const wanted = await realpathOf(input.workspaceRoot);
        const projectIds = new Set<string>();
        for (const project of input.readModel.projects) {
          if (
            !project.workspaceRoot ||
            (project.workspaceExecutionTargetId ?? project.executionTargetId ?? "local") !==
              input.executionTargetId
          )
            continue;
          // Unresolvable folders count as matching: fail closed on the idle check.
          const real =
            project.workspaceRoot === input.workspaceRoot
              ? wanted
              : await realpathOf(project.workspaceRoot);
          if (real === undefined || real === wanted) projectIds.add(project.id);
        }
        return convertWorkspaceMode({
          store,
          workspaceRoot: input.workspaceRoot,
          requesterMode: resolved.mode,
          targetMode: input.targetMode,
          isBusy: async () => {
            const reason = await Effect.runPromiseWith(services)(
              findWorkspaceBusyReason({
                sql: input.sql,
                terminal: input.terminal,
                readModel: input.readModel,
                projectIds,
              }),
            );
            return reason === undefined ? { busy: false } : { busy: true, reason };
          },
        });
      },
      catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
    }).pipe(Effect.catch((reason) => Effect.succeed({ kind: "refused", reason } as const)));
    input.gate.forget(input.executionTargetId);
    return outcome;
  },
);
