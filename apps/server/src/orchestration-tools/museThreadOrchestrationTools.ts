import {
  createThreadOrchestrationBridge,
  type ThreadOrchestrationBridge,
  type ThreadOrchestrationBridgeInput,
} from "./orchestrationMcpBridge.ts";
import { resolveNodeExecutable, ELECTRON_NODE_RUNTIME_ENV } from "../utils/nodeExecutable.ts";

/**
 * Muse session MCP entry for the canonical bigbud thread-tool bridge.
 *
 * Converted to the documented MSP `SessionMcpServerConfig` stdio shape with
 * required startup: a bridge that cannot start must fail session creation
 * before any prompt is sent. Injected on session/start and on exact-ID
 * session/resume; never written into the user's global Muse settings.
 * The bridge token and temp directory stay inside the bridge object and are
 * revoked/removed by `cleanup` on stop/failure — never persisted in cursors.
 */
export interface MuseOrchestrationBridgeConfig {
  readonly mcpServers: Record<
    string,
    {
      readonly transport: "stdio";
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env: Readonly<Record<string, string>>;
      readonly mode: "required";
      readonly framing: "lineDelimitedJson";
    }
  >;
}

export function buildMuseOrchestrationBridgeConfig(
  bridge: Pick<ThreadOrchestrationBridge, "serverName" | "serverPath">,
): MuseOrchestrationBridgeConfig {
  return {
    mcpServers: {
      [bridge.serverName]: {
        transport: "stdio",
        command: resolveNodeExecutable(),
        args: [bridge.serverPath],
        env: { ...ELECTRON_NODE_RUNTIME_ENV },
        mode: "required",
        framing: "lineDelimitedJson",
      },
    },
  };
}

export async function createMuseThreadOrchestrationBridge(
  input: ThreadOrchestrationBridgeInput,
): Promise<{ bridge: ThreadOrchestrationBridge; config: MuseOrchestrationBridgeConfig }> {
  const bridge = await createThreadOrchestrationBridge(input);
  return { bridge, config: buildMuseOrchestrationBridgeConfig(bridge) };
}
