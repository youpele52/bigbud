import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { sshExecutionTargetTransportVariants } from "../../../ssh/sshExecutionTarget.transport.ts";
import { ensureV2ThreadPrivateChild } from "./Orchestration.storage.ts";

/** Match workspaceTarget's trimmed, otherwise exact path identity. V2 remote preparation is POSIX-only. */
export function v2RemoteLocationIdentity(
  threadId: string,
  workspaceTargetId: string,
  workspaceCwd: string,
): string {
  if (
    !threadId ||
    !workspaceTargetId ||
    workspaceTargetId === "local" ||
    !path.posix.isAbsolute(workspaceCwd) ||
    workspaceCwd !== workspaceCwd.trim()
  )
    throw new Error(
      "V2 remote workspace requires an explicit target and absolute POSIX project root.",
    );
  return createHash("sha256")
    .update(JSON.stringify([threadId, workspaceTargetId, workspaceCwd]))
    .digest("hex");
}

/**
 * Candidate Location identities for this thread and root. Transport (agent vs direct SSH) only
 * changes how bigbud reaches the same host, so a Location created under either stays valid.
 */
export function v2RemoteLocationCandidates(
  threadId: string,
  workspaceTargetId: string,
  workspaceCwd: string,
): string[] {
  const exact = v2RemoteLocationIdentity(threadId, workspaceTargetId, workspaceCwd);
  return [
    exact,
    ...sshExecutionTargetTransportVariants(workspaceTargetId)
      .slice(1)
      .map((variant) => v2RemoteLocationIdentity(threadId, variant, workspaceCwd)),
  ];
}

const isDirectory = (candidate: string) =>
  lstat(candidate).then(
    (stat) => stat.isDirectory(),
    () => false,
  );

/** Read-only reuse verification; never creates or repairs a native Location. */
export async function assertV2RemoteLocation(
  stateDir: string,
  threadId: string,
  workspaceTargetId: string,
  workspaceCwd: string,
  nativeDirectory: string,
): Promise<void> {
  const root = path.join(await realpath(stateDir), "opencode-v2-remote-workspaces");
  const expected = v2RemoteLocationCandidates(threadId, workspaceTargetId, workspaceCwd)
    .map((identity) => path.join(root, identity))
    .find((candidate) => candidate === nativeDirectory);
  if (!expected || (await realpath(expected)) !== expected)
    throw new Error("V2 remote workspace native Location conflicts with canonical identity.");
}

/**
 * Native history keeps a stable local Location; actual workspace operations use the remote target.
 * An existing Location from the same target under another transport is reused (retained binding
 * first) so a transport-only switch keeps the thread's native session.
 */
export async function resolveV2RemoteLocation(
  stateDir: string,
  threadId: string,
  workspaceTargetId: string,
  workspaceCwd: string,
  retainedDirectory?: string,
): Promise<string> {
  const candidates = v2RemoteLocationCandidates(threadId, workspaceTargetId, workspaceCwd);
  const root = await ensureV2ThreadPrivateChild(
    await realpath(stateDir),
    "opencode-v2-remote-workspaces",
  );
  const retained = candidates.find((identity) => path.join(root, identity) === retainedDirectory);
  let identity = retained && (await isDirectory(path.join(root, retained))) ? retained : undefined;
  for (const candidate of candidates) {
    if (identity) break;
    if (await isDirectory(path.join(root, candidate))) identity = candidate;
  }
  // Retain this empty Location across session cleanup/restarts so native history never moves.
  return ensureV2ThreadPrivateChild(root, identity ?? candidates[0]!);
}
