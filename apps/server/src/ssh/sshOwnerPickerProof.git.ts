import type {
  DirectWorkspaceGitAction,
  DirectWorkspaceGitMetadataAction,
  DirectWorkspaceGitMutationRequest,
  DirectWorkspaceGitOwner,
  DirectWorkspaceGitPathReadRequest,
  DirectWorkspaceGitRequest,
} from "../git/Layers/GitCore.ssh.owner.ts";
import { DirectWorkspaceGitOutcomeUnknown } from "../git/Layers/GitCore.ssh.owner.ts";
import type { PickerProofOwner } from "./sshOwnerPickerProof.client.ts";

function knownOutcome<T extends { readonly outcome?: string }>(result: T): T {
  if (result.outcome === "cancelled" || result.outcome === "outcomeUnknown") {
    throw new DirectWorkspaceGitOutcomeUnknown(result.outcome);
  }
  return result;
}

/** Adapter for the isolated workspace read/mutation slice, not initiating-side Git transport. */
export function workspaceGitForPickerProof(
  owner: Pick<PickerProofOwner, "executeProofWorkspaceGit">,
): Required<DirectWorkspaceGitOwner> {
  async function execute(
    {
      action,
      cwd,
      executionTargetId,
    }: DirectWorkspaceGitRequest<DirectWorkspaceGitAction | DirectWorkspaceGitMetadataAction>,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const result = await owner.executeProofWorkspaceGit({
      action,
      workspaceRoot: cwd,
      executionTargetId,
    });
    signal.throwIfAborted();
    return { ...knownOutcome(result), stdoutTruncated: false, stderrTruncated: false };
  }
  async function mutate(
    { action, cwd, executionTargetId, paths }: DirectWorkspaceGitMutationRequest,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const result = await owner.executeProofWorkspaceGit({
      action,
      workspaceRoot: cwd,
      executionTargetId,
      paths,
    });
    signal.throwIfAborted();
    return { ...knownOutcome(result), stdoutTruncated: false, stderrTruncated: false };
  }
  async function readPath(
    { action, cwd, executionTargetId, path: relativePath }: DirectWorkspaceGitPathReadRequest,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const result = await owner.executeProofWorkspaceGit({
      action,
      workspaceRoot: cwd,
      executionTargetId,
      paths: [relativePath],
    });
    signal.throwIfAborted();
    return { ...knownOutcome(result), stdoutTruncated: false, stderrTruncated: false };
  }
  return {
    execute,
    statusMetadata: { execute },
    mutation: { execute: mutate },
    pathRead: { execute: readPath },
  };
}
