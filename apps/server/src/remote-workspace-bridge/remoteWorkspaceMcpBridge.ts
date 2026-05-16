import path from "node:path";

import {
  createRemoteWorkspaceBridge,
  type RemoteWorkspaceBridge,
} from "./remoteWorkspaceBridge.ts";
import type { WorkspaceTarget } from "../workspace-target/workspaceTarget.ts";
import { renderRemoteWorkspaceMcpServerSource } from "./remoteWorkspaceMcpBridge.template.ts";

export interface RemoteWorkspaceMcpBridge {
  readonly cwd: string;
  readonly serverPath: string;
  readonly cleanup: () => Promise<void>;
}

async function writeBridgeFiles(bridge: RemoteWorkspaceBridge): Promise<string> {
  const serverPath = path.join(bridge.bridgeDir, "remote-workspace-mcp-server.mjs");
  await bridge.writeWorkspaceFile(
    ".bigbud/remote-workspace-mcp-server.mjs",
    renderRemoteWorkspaceMcpServerSource(bridge.config),
  );
  return serverPath;
}

export async function createRemoteWorkspaceMcpBridge(
  workspaceTarget: WorkspaceTarget,
  prefix: string,
  readmeLines: ReadonlyArray<string>,
): Promise<RemoteWorkspaceMcpBridge> {
  const bridge = await createRemoteWorkspaceBridge({
    workspaceTarget,
    prefix,
    readmeLines,
  });
  const serverPath = await writeBridgeFiles(bridge);
  return {
    cwd: bridge.cwd,
    serverPath,
    cleanup: () => bridge.cleanup(),
  };
}
