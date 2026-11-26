/**
 * W7 production workspace-mode reservation on SSH targets.
 *
 * The live production owner serves `workspace_mode_inspect` and
 * `workspace_mode_publish` (Request 47/48) for the exact target with the
 * request's own root: the host resolves the physical root, account and machine
 * identity again on every call, and a publication is only accepted against the
 * single-use observation of that target's inspection. Nothing in TypeScript
 * launches SSH; without a live owner every call reports `unavailable`.
 *
 * The store keeps the gate's laptop-runtime semantics (lazy claims that cannot
 * reach the host only log; an unsupported host is not reserved). It publishes
 * only the canonical laptop-runtime claim; conversion to another mode over SSH
 * is refused by `makeOwnedSshWorkspaceModeStore` rather than guessed.
 *
 * @module workspaceMode.ssh.production
 */
import { workspaceModeForPickerProof } from "../ssh/sshOwnerPickerProof.workspaceMode.ts";
import {
  readSshOwnerProductionOwner,
  type SshOwnerProductionRegistration,
} from "../ssh/sshOwnerProductionRegistry.ts";
import { withProductionWorkspaceOwner } from "../ws/wsSshOwnerProduction.workspace.ts";
import type { WorkspaceModeStore } from "./workspaceMode.record.ts";
import {
  makeOwnedSshWorkspaceModeStore,
  type WorkspaceModeSshOwner,
  type WorkspaceModeSshScope,
} from "./workspaceMode.ssh.owner.ts";

const TIMEOUT_MS = 15_000;

/** Routes each call to the live owner's client for the call's own exact target. */
export function makeProductionWorkspaceModeSshOwner(
  read: () => SshOwnerProductionRegistration | undefined = readSshOwnerProductionOwner,
): WorkspaceModeSshOwner {
  const forScope = (scope: WorkspaceModeSshScope) =>
    workspaceModeForPickerProof(scope, {
      inspectProofWorkspaceMode: (input) =>
        withProductionWorkspaceOwner(read, scope.executionTargetId, (owner) =>
          owner.inspectProofWorkspaceMode(input),
        ),
      publishProofWorkspaceMode: (request) =>
        withProductionWorkspaceOwner(read, scope.executionTargetId, (owner) =>
          owner.publishProofWorkspaceMode(request),
        ),
    });
  return {
    inspectWorkspaceMode: (request, signal) =>
      forScope(request).inspectWorkspaceMode(request, signal),
    publishWorkspaceMode: (request, signal) =>
      forScope(request.observation).publishWorkspaceMode(request, signal),
  };
}

/**
 * A store for one SSH target whose root is chosen per inspection. Each
 * inspection opens a fresh owned store bound to that root, and a publication
 * uses the store of the latest inspection only.
 */
export function makeProductionSshWorkspaceModeStore(
  executionTargetId: string,
  owner: WorkspaceModeSshOwner = makeProductionWorkspaceModeSshOwner(),
  timeoutMs = TIMEOUT_MS,
): WorkspaceModeStore {
  let latest: WorkspaceModeStore | undefined;
  return {
    async inspect(workspaceRoot) {
      latest = undefined;
      const store = makeOwnedSshWorkspaceModeStore(executionTargetId, timeoutMs, {
        owner,
        workspaceRoot,
      });
      const result = await store.inspect(workspaceRoot);
      latest = store;
      return result;
    },
    async publish(next) {
      if (!latest)
        throw new Error("SSH workspace mode publication requires an inspected reservation claim.");
      return latest.publish(next);
    },
  };
}
