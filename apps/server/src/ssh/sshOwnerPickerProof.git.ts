import type {
  DirectWorkspaceGitAction,
  DirectWorkspaceGitDiffReadRequest,
  DirectWorkspaceGitHistoryRequest,
  DirectWorkspaceGitTemplateRequest,
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
  async function readDiff(
    { action, cwd, executionTargetId, paths }: DirectWorkspaceGitDiffReadRequest,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const result = await owner.executeProofWorkspaceGit({
      action,
      workspaceRoot: cwd,
      executionTargetId,
      ...(paths.length > 0 ? { paths } : {}),
    });
    signal.throwIfAborted();
    return { ...knownOutcome(result), stdoutTruncated: false, stderrTruncated: false };
  }
  async function readHistory(
    { cwd, executionTargetId, ...operands }: DirectWorkspaceGitHistoryRequest,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const { paths, ...rest } = operands;
    const result = await owner.executeProofWorkspaceGit({
      ...rest,
      workspaceRoot: cwd,
      executionTargetId,
      ...(paths.length > 0 ? { paths } : {}),
    });
    signal.throwIfAborted();
    const { stdoutTruncated = false, ...known } = knownOutcome(result);
    return { ...known, stdoutTruncated, stderrTruncated: false };
  }
  async function runTemplate(
    { action, cwd, executionTargetId, operands }: DirectWorkspaceGitTemplateRequest,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const result = await owner.executeProofWorkspaceGit({
      action,
      workspaceRoot: cwd,
      executionTargetId,
      ...(operands.length > 0 ? { operands } : {}),
    });
    signal.throwIfAborted();
    const { stdoutTruncated = false, ...known } = knownOutcome(result);
    return { ...known, stdoutTruncated, stderrTruncated: false };
  }
  return {
    execute,
    template: { execute: runTemplate },
    history: { execute: readHistory },
    statusMetadata: { execute },
    mutation: { execute: mutate },
    pathRead: { execute: readPath },
    diffRead: { execute: readDiff },
  };
}
