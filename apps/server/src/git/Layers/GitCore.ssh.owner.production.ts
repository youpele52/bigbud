import { workspaceGitForPickerProof } from "../../ssh/sshOwnerPickerProof.git.ts";
import { readSshOwnerProductionOwner } from "../../ssh/sshOwnerProductionRegistry.ts";
import {
  productionShellTarget,
  type ProductionOwnerSource,
} from "../../ssh/sshShellRunner.production.ts";
import type { DirectWorkspaceGitOwner } from "./GitCore.ssh.owner.ts";

/**
 * C06 (B): direct workspace Git on an SSH target through the live production owner. Every
 * request resolves the exact target (`resolveProductionTargetDescriptor` via the registry) and
 * sends the fixed `workspace_git` recipe with the project's workspace root; the owner admits it
 * under that root only, with its fixed environment, guard, deadline and output cap. A missing
 * owner or an unresolvable target rejects before anything is sent; there is no fallback.
 *
 * @module GitCore.ssh.owner.production
 */
export function makeProductionWorkspaceGitOwner(
  owner: ProductionOwnerSource = readSshOwnerProductionOwner,
): Required<DirectWorkspaceGitOwner> {
  const forTarget = async (executionTargetId: string) =>
    workspaceGitForPickerProof(await productionShellTarget(owner, executionTargetId));
  return {
    execute: async (request, signal) =>
      (await forTarget(request.executionTargetId)).execute(request, signal),
    statusMetadata: {
      execute: async (request, signal) =>
        (await forTarget(request.executionTargetId)).statusMetadata.execute(request, signal),
    },
    mutation: {
      execute: async (request, signal) =>
        (await forTarget(request.executionTargetId)).mutation.execute(request, signal),
    },
    pathRead: {
      execute: async (request, signal) =>
        (await forTarget(request.executionTargetId)).pathRead.execute(request, signal),
    },
    template: {
      execute: async (request, signal) =>
        (await forTarget(request.executionTargetId)).template.execute(request, signal),
    },
    history: {
      execute: async (request, signal) =>
        (await forTarget(request.executionTargetId)).history.execute(request, signal),
    },
    diffRead: {
      execute: async (request, signal) =>
        (await forTarget(request.executionTargetId)).diffRead.execute(request, signal),
    },
  };
}
