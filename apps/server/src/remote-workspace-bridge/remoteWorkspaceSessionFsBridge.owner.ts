import { posix } from "node:path";

import type { PickerProofOwner } from "../ssh/sshOwnerPickerProof.client.ts";
import type { WorkspaceTarget } from "../workspace-target/workspaceTarget.ts";
import { SelectedSshOwnerWorkspaceBridgeError } from "./remoteWorkspaceReadiness.ts";
import {
  REMOTE_WORKSPACE_SESSION_STATE_PATH,
  resolveSessionFsPath,
} from "./remoteWorkspaceSessionFsBridge.paths.ts";

const MAX_FILE_BYTES = 512 * 1024; // Existing owner range ceiling; no multi-request assembly.

type ReadOwner = Pick<
  PickerProofOwner,
  | "ownerEpoch"
  | "trackedGitTargetGeneration"
  | "probeProofWorkspaceReadiness"
  | "readProofWorkspaceFile"
  | "writeProofWorkspaceFile"
  | "createProofWorkspaceDirectory"
  | "deleteProofWorkspaceEntry"
>;

export interface SessionFsOwnerWorkspace {
  readonly targetId: string;
  readonly workspaceRoot: string;
  readonly withOwner: <A>(targetId: string, use: (owner: ReadOwner) => Promise<A>) => Promise<A>;
}

export const sessionFsUnavailable = () =>
  new SelectedSshOwnerWorkspaceBridgeError("session-filesystem");

const identity = (owner: ReadOwner) =>
  `${Buffer.from(owner.ownerEpoch).toString("hex")}:${owner.trackedGitTargetGeneration}`;

export async function bindSessionFsOwner(
  workspace: SessionFsOwnerWorkspace | undefined,
  target: WorkspaceTarget,
) {
  if (
    !workspace ||
    target.location !== "remote" ||
    target.executionTargetId !== workspace.targetId ||
    target.cwd !== workspace.workspaceRoot ||
    workspace.workspaceRoot === "/" ||
    !posix.isAbsolute(workspace.workspaceRoot) ||
    posix.normalize(workspace.workspaceRoot) !== workspace.workspaceRoot ||
    workspace.workspaceRoot.endsWith("/") ||
    workspace.workspaceRoot.includes("\0")
  ) {
    throw sessionFsUnavailable();
  }
  const { targetId, workspaceRoot, withOwner } = workspace;
  const generation = await withOwner(targetId, async (owner) => identity(owner));
  let caller: string | undefined;
  let closed = false;
  return {
    workspaceRoot,
    bindCaller(sessionId: string) {
      if (closed || !sessionId || (caller !== undefined && caller !== sessionId))
        throw sessionFsUnavailable();
      caller = sessionId;
    },
    close() {
      closed = true;
    },
    async readBytes(sessionId: string, inputPath: string, bridgeCwd: string) {
      if (closed || caller === undefined || sessionId !== caller) throw sessionFsUnavailable();
      if (!inputPath || inputPath.includes("\0") || inputPath.split("/").includes(".."))
        throw sessionFsUnavailable();
      const resolved = resolveSessionFsPath(inputPath, workspaceRoot, bridgeCwd);
      if (resolved.kind !== "workspace" || !resolved.path.startsWith(`${workspaceRoot}/`))
        throw sessionFsUnavailable();
      const relativePath = resolved.path.slice(workspaceRoot.length + 1);
      if (
        !relativePath ||
        relativePath === REMOTE_WORKSPACE_SESSION_STATE_PATH ||
        relativePath.startsWith(`${REMOTE_WORKSPACE_SESSION_STATE_PATH}/`)
      )
        throw sessionFsUnavailable();
      const result = await withOwner(targetId, async (owner) => {
        if (closed || identity(owner) !== generation) throw sessionFsUnavailable();
        const reply = await owner.readProofWorkspaceFile({
          executionTargetId: targetId,
          workspaceRoot,
          relativePath,
          kind: "range",
          offset: 0,
          maxBytes: MAX_FILE_BYTES,
        });
        if (closed || identity(owner) !== generation) throw sessionFsUnavailable();
        return reply;
      });
      if (
        closed ||
        result.truncated ||
        result.sizeBytes !== result.data.length ||
        result.data.length > MAX_FILE_BYTES
      )
        throw sessionFsUnavailable();
      return result.data;
    },
  };
}

export function decodeSessionFsText(bytes: Uint8Array): string {
  if (bytes.includes(0)) throw sessionFsUnavailable();
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}
