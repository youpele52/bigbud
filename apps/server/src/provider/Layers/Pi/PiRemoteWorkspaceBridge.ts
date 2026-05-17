import path from "node:path";

import { createRemoteWorkspaceBridge } from "../../../remote-workspace-bridge/remoteWorkspaceBridge.ts";
import type { WorkspaceTarget } from "../../../workspace-target/workspaceTarget.ts";
import { renderPiRemoteWorkspaceBridgeSource } from "./PiRemoteWorkspaceBridge.template.ts";

const PI_REMOTE_WORKSPACE_BRIDGE_PREFIX = "bigbud-pi-remote-workspace-";

export interface PiRemoteWorkspaceExtensionBridge {
  readonly cwd: string;
  readonly extensionPath: string;
  readonly extraArgs: ReadonlyArray<string>;
  readonly cleanup: () => Promise<void>;
}

export async function createPiRemoteWorkspaceBridge(
  workspaceTarget: WorkspaceTarget,
): Promise<PiRemoteWorkspaceExtensionBridge> {
  const bridge = await createRemoteWorkspaceBridge({
    workspaceTarget,
    prefix: PI_REMOTE_WORKSPACE_BRIDGE_PREFIX,
    readmeLines: [
      "This directory is a synthetic local workspace used to run Pi against a remote workspace.",
      "The actual project files live on the remote host configured for this thread.",
      "",
    ],
  });
  const extensionPath = path.join(bridge.bridgeDir, "bigbud-remote-workspace-bridge.ts");
  const extensionSource = renderPiRemoteWorkspaceBridgeSource(bridge.config);
  await bridge.writeWorkspaceFile(".bigbud/bigbud-remote-workspace-bridge.ts", extensionSource);

  return {
    cwd: bridge.cwd,
    extensionPath,
    extraArgs: ["--no-builtin-tools", "--no-extensions", "--extension", extensionPath],
    cleanup: () => bridge.cleanup(),
  };
}
