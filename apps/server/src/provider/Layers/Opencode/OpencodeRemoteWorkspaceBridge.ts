import {
  createRemoteWorkspaceBridge,
  type RemoteWorkspaceBridge,
} from "../../../remote-workspace-bridge/remoteWorkspaceBridge.ts";
import type { WorkspaceTarget } from "../../../workspace-target/workspaceTarget.ts";
import { renderOpencodeRemoteWorkspaceBridgeFiles } from "./OpencodeRemoteWorkspaceBridge.template.ts";

export interface OpencodeRemoteWorkspaceBridge {
  readonly cwd: string;
  readonly cleanup: () => Promise<void>;
}

async function writeBridgeFiles(
  bridge: RemoteWorkspaceBridge,
  workspaceTarget: WorkspaceTarget,
): Promise<void> {
  const files = renderOpencodeRemoteWorkspaceBridgeFiles(bridge.config);
  await Promise.all(
    Object.entries(files).map(([relativePath, source]) =>
      bridge.writeWorkspaceFile(relativePath, source),
    ),
  );
  await bridge.writeWorkspaceFile(
    ".opencode/README.txt",
    [
      "This OpenCode project is a synthetic local workspace.",
      `Remote workspace root: ${workspaceTarget.cwd ?? "[remote shell default cwd]"}`,
      "Built-in filesystem and shell tools are overridden to operate on the remote workspace over SSH.",
      "",
    ].join("\n"),
  );
}

export async function createOpencodeRemoteWorkspaceBridge(
  workspaceTarget: WorkspaceTarget,
): Promise<OpencodeRemoteWorkspaceBridge> {
  const bridge = await createRemoteWorkspaceBridge({
    workspaceTarget,
    prefix: "bigbud-opencode-remote-workspace-",
    readmeLines: [
      "This directory is a synthetic local workspace used to run OpenCode against a remote workspace.",
      "The actual project files live on the remote host configured for this thread.",
      "",
    ],
  });
  await writeBridgeFiles(bridge, workspaceTarget);
  return {
    cwd: bridge.cwd,
    cleanup: () => bridge.cleanup(),
  };
}
