import { PickerProofOwnerError } from "../ssh/sshOwnerPickerProof.client.ts";
import type { PickerProofWorkspaceClient } from "../ssh/sshOwnerPickerProof.client.workspace.ts";
import {
  readSshOwnerProductionOwner,
  type SshOwnerProductionRegistration,
} from "../ssh/sshOwnerProductionRegistry.ts";
import { descriptorServesTarget } from "../ssh/sshOwnerProductionTargets.ts";
import {
  productionGuardedWrite,
  type ProductionGuardedWriteJournal,
} from "./wsSshOwnerProduction.workspace.guarded.ts";
import type { WorkspaceMutationsShape } from "../workspace-runtime/Services/WorkspaceMutations.ts";
import type { WorkspaceRuntimeShape } from "../workspace-runtime/Services/WorkspaceRuntime.ts";
import {
  isWsSshOwnerWorkspaceTarget,
  withWsSshOwnerEntryActions,
} from "./wsSshOwnerDev.workspace.create.ts";
import {
  withWsSshOwnerWorkspace,
  type SshOwnerWorkspaceBinding,
} from "./wsSshOwnerDev.workspace.ts";

/**
 * W2 T-files production Files composition.
 *
 * Every `ssh:` workspace request is served by the live production owner's
 * client for that exact target (`descriptorFor` → `handle.target`), with the
 * request's own workspace root. The owner admits that root only under its
 * production rule (absolute, normalized, never `/`, no symlink on the walk).
 * There is no legacy fallback: without a live owner the request is refused
 * typed, before dispatch.
 *
 * New File uses the owner's exclusive create (typed created/alreadyExists, a
 * lost reply is `unknown` and never retried). Guarded (hash-checked) saves use
 * the target's own owner lane after a durable journal claim; without the
 * journal they are refused `not-dispatched`, never downgraded.
 *
 * @module wsSshOwnerProduction.workspace
 */

export type ProductionOwnerRead = () => SshOwnerProductionRegistration | undefined;

/** Runs `use` with the production owner's bound client for this exact runtime target. */
export async function withProductionWorkspaceOwner<A>(
  read: ProductionOwnerRead,
  targetId: string,
  use: (owner: PickerProofWorkspaceClient) => Promise<A>,
  signal?: AbortSignal,
): Promise<A> {
  signal?.throwIfAborted();
  const live = read();
  if (!live) throw new PickerProofOwnerError("ownerUnavailable");
  // A resolver refusal is a typed `SshOwnerTargetRefusal`; it never dispatches.
  const descriptor = await live.descriptorFor(targetId);
  if (!descriptorServesTarget(descriptor, targetId))
    throw new PickerProofOwnerError("targetMismatch");
  signal?.throwIfAborted();
  return use(live.handle.target(descriptor));
}

/** One binding per request: the exact runtime target and the request's own root. */
export function productionWorkspaceBindingFor(
  read: ProductionOwnerRead,
  journal?: ProductionGuardedWriteJournal,
) {
  return (input: {
    readonly cwd: string;
    readonly executionTargetId?: string | undefined;
  }): SshOwnerWorkspaceBinding | string => {
    const targetId = input.executionTargetId;
    if (!targetId || !isWsSshOwnerWorkspaceTarget(targetId))
      return "This workspace is not an SSH target.";
    if (!input.cwd.startsWith("/") || input.cwd.includes("\0"))
      return "The SSH workspace root must be an absolute remote path.";
    const workspaceRoot = input.cwd;
    return {
      targetId,
      workspaceRoot,
      withOwner: (id, use, signal) => withProductionWorkspaceOwner(read, id, use, signal),
      // Guarded saves need the durable journal; without it they stay refused.
      ...(journal
        ? { guardedWrite: productionGuardedWrite(read, journal, targetId, workspaceRoot) }
        : {}),
      exclusiveCreate: {
        apply: ({ relativePath, contents }) =>
          withProductionWorkspaceOwner(read, targetId, (owner) =>
            owner.createProofWorkspaceFile({
              executionTargetId: targetId,
              workspaceRoot,
              relativePath,
              contents,
            }),
          ),
      },
    };
  };
}

export interface ProductionWorkspaceContext {
  readonly workspaceRuntime: WorkspaceRuntimeShape;
  readonly workspaceMutations: WorkspaceMutationsShape | undefined;
}

/** Wraps the context's Files runtime and folder mutations with the production owner. */
export const withWsSshOwnerProductionWorkspace = (
  context: ProductionWorkspaceContext,
  options: {
    readonly read?: ProductionOwnerRead;
    readonly journal?: ProductionGuardedWriteJournal;
  } = {},
) => {
  const bindingFor = productionWorkspaceBindingFor(
    options.read ?? readSshOwnerProductionOwner,
    options.journal,
  );
  return {
    workspaceMutations: withWsSshOwnerEntryActions(context.workspaceMutations, (input) => {
      const binding = bindingFor(input);
      return typeof binding === "string" ? undefined : binding;
    }),
    workspaceRuntime: withWsSshOwnerWorkspace(context.workspaceRuntime, bindingFor),
  };
};
