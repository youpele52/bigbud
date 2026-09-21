import path from "node:path";

import {
  createRemoteWorkspaceBridge,
  type RemoteWorkspaceBridge,
} from "./remoteWorkspaceBridge.ts";
import type { WorkspaceTarget } from "../workspace-target/workspaceTarget.ts";
import type { ThreadOrchestrationHttpConfig } from "../orchestration-tools/threadOrchestrationBridge.shared.ts";
import { deriveMcpInvocationStatePath } from "../orchestration-tools/mcpInvocationStatePath.ts";
import { renderRemoteWorkspaceMcpServerSource } from "./remoteWorkspaceMcpBridge.template.ts";
import {
  probeRemoteWorkspaceReadiness,
  type RemoteWorkspaceReadinessProbe,
} from "./remoteWorkspaceReadiness.ts";

export interface RemoteWorkspaceMcpBridge {
  readonly cwd: string;
  readonly serverPath: string;
  readonly cleanup: () => Promise<void>;
}

async function writeBridgeFiles(
  bridge: RemoteWorkspaceBridge,
  httpConfig: ThreadOrchestrationHttpConfig,
): Promise<string> {
  const serverPath = path.join(bridge.bridgeDir, "remote-workspace-mcp-server.mjs");
  const providerInvocationStatePath = httpConfig.providerInvocationStatePath
    ? deriveMcpInvocationStatePath(httpConfig.providerInvocationStatePath, "remote-workspace")
    : undefined;
  await bridge.writeWorkspaceFile(
    ".bigbud/remote-workspace-mcp-server.mjs",
    renderRemoteWorkspaceMcpServerSource({
      ...httpConfig,
      ...(providerInvocationStatePath ? { providerInvocationStatePath } : {}),
    }),
  );
  return serverPath;
}

export async function createRemoteWorkspaceMcpBridge(
  workspaceTarget: WorkspaceTarget,
  prefix: string,
  readmeLines: ReadonlyArray<string>,
  httpConfig: ThreadOrchestrationHttpConfig,
  readinessProbe: RemoteWorkspaceReadinessProbe = probeRemoteWorkspaceReadiness,
): Promise<RemoteWorkspaceMcpBridge> {
  await readinessProbe(workspaceTarget);
  const bridge = await createRemoteWorkspaceBridge({
    workspaceTarget,
    prefix,
    readmeLines,
  });
  const serverPath = await writeBridgeFiles(bridge, httpConfig);
  return {
    cwd: bridge.cwd,
    serverPath,
    cleanup: () => bridge.cleanup(),
  };
}
