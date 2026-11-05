import path from "node:path";
import { randomUUID } from "node:crypto";

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
  filename: string,
): Promise<string> {
  const serverPath = path.join(bridge.bridgeDir, filename);
  const providerInvocationStatePath = httpConfig.providerInvocationStatePath
    ? deriveMcpInvocationStatePath(httpConfig.providerInvocationStatePath, "remote-workspace")
    : undefined;
  await bridge.writeWorkspaceFile(
    `.bigbud/${filename}`,
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
  location?: { readonly directory: string; readonly retainDirectory: boolean },
): Promise<RemoteWorkspaceMcpBridge> {
  await readinessProbe(workspaceTarget);
  const bridge = await createRemoteWorkspaceBridge({
    workspaceTarget,
    prefix,
    readmeLines,
    ...location,
  });
  try {
    // A retained Location gets a new command on every acquisition so native MCP reconnects
    // with the new credentials instead of keeping an identical-config process alive.
    const filename = location
      ? `remote-workspace-${randomUUID()}.mjs`
      : "remote-workspace-mcp-server.mjs";
    const serverPath = await writeBridgeFiles(bridge, httpConfig, filename);
    return { cwd: bridge.cwd, serverPath, cleanup: () => bridge.cleanup() };
  } catch (error) {
    await bridge.cleanup();
    throw error;
  }
}
