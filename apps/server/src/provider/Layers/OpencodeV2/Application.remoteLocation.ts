import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
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

/** Read-only reuse verification; never creates or repairs a native Location. */
export async function assertV2RemoteLocation(
  stateDir: string,
  threadId: string,
  workspaceTargetId: string,
  workspaceCwd: string,
  nativeDirectory: string,
): Promise<void> {
  const expected = path.join(
    await realpath(stateDir),
    "opencode-v2-remote-workspaces",
    v2RemoteLocationIdentity(threadId, workspaceTargetId, workspaceCwd),
  );
  if (nativeDirectory !== expected || (await realpath(expected)) !== expected)
    throw new Error("V2 remote workspace native Location conflicts with canonical identity.");
}

/** Native history keeps a stable local Location; actual workspace operations use the remote target. */
export async function resolveV2RemoteLocation(
  stateDir: string,
  threadId: string,
  workspaceTargetId: string,
  workspaceCwd: string,
): Promise<string> {
  const identity = v2RemoteLocationIdentity(threadId, workspaceTargetId, workspaceCwd);
  const root = await ensureV2ThreadPrivateChild(
    await realpath(stateDir),
    "opencode-v2-remote-workspaces",
  );
  // Retain this empty Location across session cleanup/restarts so native history never moves.
  return ensureV2ThreadPrivateChild(root, identity);
}
