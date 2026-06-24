import {
  buildAcpOrchestrationBridgeConfig,
  buildClaudeOrchestrationBridgeConfig,
  buildCodexOrchestrationBridgeConfig,
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
