import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import {
  buildAcpOrchestrationBridgeConfig,
  buildClaudeOrchestrationBridgeConfig,
  buildCodexOrchestrationBridgeConfig,
  buildOpencodeOrchestrationBridgeConfig,
  createThreadOrchestrationBridge,
  type ThreadOrchestrationBridge,
} from "./orchestrationMcpBridge.ts";
import {
  resolveOrchestrationBridgeHost,
  type ThreadOrchestrationSessionBridgeInput,
} from "./threadOrchestrationBridge.shared.ts";

export { resolveOrchestrationBridgeHost, type ThreadOrchestrationSessionBridgeInput };

export function composeBridgeCleanups(
  ...cleanups: ReadonlyArray<(() => Promise<void>) | undefined>
): () => Promise<void> {
  const fns = cleanups.filter((cleanup): cleanup is () => Promise<void> => cleanup !== undefined);
  return async () => {
    await Promise.all(fns.map((cleanup) => cleanup().catch(() => undefined)));
  };
}

export async function prepareThreadOrchestrationMcpBridge(
  input: ThreadOrchestrationSessionBridgeInput,
): Promise<ThreadOrchestrationBridge> {
  return createThreadOrchestrationBridge(input);
}

export function buildCodexSessionOrchestrationConfig(
  bridge: Pick<ThreadOrchestrationBridge, "serverName" | "serverPath" | "bridgeDir">,
) {
  return buildCodexOrchestrationBridgeConfig(bridge);
}

export function buildClaudeSessionOrchestrationConfig(
  bridge: Pick<ThreadOrchestrationBridge, "serverName" | "serverPath">,
) {
  return buildClaudeOrchestrationBridgeConfig(bridge);
}

export function buildAcpSessionOrchestrationConfig(
  bridge: Pick<ThreadOrchestrationBridge, "serverName" | "serverPath">,
) {
  return buildAcpOrchestrationBridgeConfig(bridge);
}

export function buildOpencodeSessionOrchestrationConfig(
  bridge: Pick<ThreadOrchestrationBridge, "serverName" | "serverPath">,
) {
  return buildOpencodeOrchestrationBridgeConfig(bridge);
}

export async function registerOpencodeOrchestrationMcpBridge(input: {
  readonly client: OpencodeClient;
  readonly directory?: string;
  readonly bridge: Pick<ThreadOrchestrationBridge, "serverName" | "serverPath">;
}): Promise<void> {
  const orchestration = buildOpencodeOrchestrationBridgeConfig(input.bridge);
  const addResult = await input.client.mcp.add({
    ...(input.directory ? { directory: input.directory } : {}),
    name: orchestration.name,
    config: orchestration.config,
  });
  if (addResult.error) {
    throw new Error(`Failed to register orchestration MCP server: ${String(addResult.error)}`);
  }

  const connectResult = await input.client.mcp.connect({
    name: orchestration.name,
    ...(input.directory ? { directory: input.directory } : {}),
  });
  if (connectResult.error) {
    throw new Error(`Failed to connect orchestration MCP server: ${String(connectResult.error)}`);
  }
}

export async function prepareAcpThreadOrchestrationBridge(
  input: ThreadOrchestrationSessionBridgeInput,
): Promise<{
  readonly bridge: ThreadOrchestrationBridge;
  readonly mcpServers: ReturnType<typeof buildAcpOrchestrationBridgeConfig>["mcpServers"];
}> {
  const bridge = await prepareThreadOrchestrationMcpBridge(input);
  return {
    bridge,
    ...buildAcpSessionOrchestrationConfig(bridge),
  };
}
