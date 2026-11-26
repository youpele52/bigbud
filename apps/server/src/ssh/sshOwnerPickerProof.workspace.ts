import type { WorkspaceContentSearchOwnerShape } from "../workspace/Services/WorkspaceContentSearchOwner.ts";
import type { WorkspaceDirectoryReadOwnerShape } from "../workspace/Services/WorkspaceDirectoryReadOwner.ts";
import type { WorkspaceFileReadOwnerShape } from "../workspace/Services/WorkspaceFileReadOwner.ts";
import type { WorkspaceIndexReadOwnerShape } from "../workspace/Services/WorkspaceIndexReadOwner.ts";
import type { WorkspaceMutationWatchOwnerShape } from "../workspace/Services/WorkspaceMutationWatchOwner.ts";
import { decodeWorkspaceFilePreview } from "../workspace/WorkspaceFilePreview.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.client.ts";
import type { PickerProofWorkspaceClient } from "./sshOwnerPickerProof.client.workspace.ts";
import { MAX_WORKSPACE_STAGED_WRITE_BYTES } from "./sshOwnerPickerProof.codec.workspace.mutation.ts";

export function workspaceContentSearchForPickerProof(
  owner: PickerProofWorkspaceClient,
): WorkspaceContentSearchOwnerShape {
  return {
    async searchFileContents({ executionTargetId, cwd, query, limit }) {
      try {
        return {
          ...(await owner.searchProofWorkspaceContents({
            executionTargetId,
            workspaceRoot: cwd,
            query,
            limit,
          })),
          notice: "use-managed-agent",
        };
      } catch (error) {
        if (error instanceof PickerProofOwnerError && error.code === "proofRipgrepUnavailable") {
          throw new Error("Command not found: rg", { cause: error });
        }
        throw error;
      }
    },
  };
}

export function workspaceDirectoryForPickerProof(
  owner: PickerProofWorkspaceClient,
): WorkspaceDirectoryReadOwnerShape {
  return {
    listDirectory: ({ executionTargetId, cwd, relativeDir }) =>
      owner.listProofWorkspaceDirectory({ executionTargetId, workspaceRoot: cwd, relativeDir }),
  };
}

export function workspaceIndexForPickerProof(
  owner: PickerProofWorkspaceClient,
): WorkspaceIndexReadOwnerShape {
  return {
    indexWorkspace: ({ executionTargetId, cwd }) =>
      owner.indexProofWorkspace({ executionTargetId, workspaceRoot: cwd }),
  };
}

export function workspaceMutationWatchForPickerProof(
  owner: PickerProofWorkspaceClient,
): WorkspaceMutationWatchOwnerShape {
  return {
    snapshotDirectory: ({ executionTargetId, cwd, relativePath }, signal) =>
      owner.snapshotProofWorkspaceDirectory(
        {
          executionTargetId,
          workspaceRoot: cwd,
          relativeDir: relativePath,
        },
        signal,
      ),
    writeFile: ({ executionTargetId, cwd, relativePath, contents }) =>
      owner.writeProofWorkspaceFile({
        executionTargetId,
        workspaceRoot: cwd,
        relativePath,
        contents: new TextEncoder().encode(contents),
      }),
    maxWriteBytes: MAX_WORKSPACE_STAGED_WRITE_BYTES,
  };
}

/** The isolated workflow's typed owner port. This is not a server composition layer. */
export function workspaceReadsForPickerProof(
  owner: PickerProofWorkspaceClient,
): WorkspaceFileReadOwnerShape {
  return {
    async readFilePreview({ executionTargetId, cwd, relativePath }) {
      const result = await owner.readProofWorkspaceFile({
        executionTargetId,
        workspaceRoot: cwd,
        relativePath,
        kind: "preview",
      });
      return {
        contents: decodeWorkspaceFilePreview(result.data),
        sizeBytes: result.sizeBytes,
        truncated: result.truncated,
        ...(result.sha256 ? { sha256: result.sha256 } : {}),
      };
    },
    async readFileRange({ executionTargetId, cwd, relativePath, offset, maxBytes }) {
      const result = await owner.readProofWorkspaceFile({
        executionTargetId,
        workspaceRoot: cwd,
        relativePath,
        kind: "range",
        offset,
        maxBytes,
      });
      return { bytes: result.data, sizeBytes: result.sizeBytes, truncated: result.truncated };
    },
  };
}
