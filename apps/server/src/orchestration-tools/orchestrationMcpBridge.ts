import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_ORCHESTRATION_MCP_SERVER_NAME } from "./orchestrationMcpBridge.template.shared.ts";
import { renderOrchestrationMcpServerSource } from "./orchestrationMcpBridge.template.ts";
import { deleteThreadOrchestrationToolAuth } from "./ThreadOrchestrationToolAuth.ts";
import {
  prepareThreadOrchestrationSessionAuth,
  resolveThreadOrchestrationHttpConfig,
  type ThreadOrchestrationHttpConfig,
} from "./threadOrchestrationBridge.shared.ts";
import { resolveMcpInvocationStatePath } from "./mcpInvocationStatePath.ts";
import { ELECTRON_NODE_RUNTIME_ENV, resolveNodeExecutable } from "../utils/nodeExecutable.ts";
import { AGENT_WORKSPACE_TOOL_NAMES } from "./AgentWorkspaceTools.ts";

export interface ThreadOrchestrationBridgeInput {
  readonly stateDir: string;
  readonly threadId: string;
  readonly host: string | undefined;
  readonly port: number;
  readonly serverName?: string;
  readonly providerSessionId?: string;
}

export interface ThreadOrchestrationBridge {
  readonly serverName: string;
  readonly serverPath: string;
  readonly bridgeDir: string;
  readonly token: string;
  readonly httpConfig: ThreadOrchestrationHttpConfig;
  readonly cleanup: () => Promise<void>;
}

export interface CodexOrchestrationBridgeConfig {
  readonly configArgs: ReadonlyArray<string>;
  readonly serverName: string;
}

export interface ClaudeOrchestrationBridgeConfig {
  readonly mcpServers: Record<
    string,
    {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env: Readonly<Record<string, string>>;
    }
  >;
  readonly allowedTools: ReadonlyArray<string>;
}

export interface AcpOrchestrationBridgeConfig {
  readonly mcpServers: ReadonlyArray<{
    readonly name: string;
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly env: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  }>;
}

export interface OpencodeOrchestrationBridgeConfig {
  readonly name: string;
  readonly config: {
    readonly type: "local";
    readonly command: Array<string>;
    readonly cwd?: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly enabled: true;
    readonly timeout: number;
  };
}

export const OPENCODE_ORCHESTRATION_MCP_TOOL_TIMEOUT_MS = 10_000;

function quoteTomlString(value: string): string {
  return JSON.stringify(value);
}

function quoteTomlStringArray(values: ReadonlyArray<string>): string {
  return `[${values.map(quoteTomlString).join(", ")}]`;
}

export async function createThreadOrchestrationBridge(
  input: ThreadOrchestrationBridgeInput,
): Promise<ThreadOrchestrationBridge> {
  const bridgeDir = await mkdtemp(path.join(os.tmpdir(), "bigbud-orchestration-mcp-"));
  const { token } = await prepareThreadOrchestrationSessionAuth({
    stateDir: input.stateDir,
    threadId: input.threadId,
  });
  const httpConfig = resolveThreadOrchestrationHttpConfig(input, token);
  const providerSessionId = httpConfig.providerSessionId ?? input.threadId;
  const invocationStatePath = resolveMcpInvocationStatePath({
    stateDir: input.stateDir,
    threadId: input.threadId,
    providerSessionId,
    namespace: "orchestration",
  });
  await mkdir(path.join(bridgeDir, ".bigbud"), { recursive: true });
  const durableHttpConfig = {
    ...httpConfig,
    providerInvocationStatePath: invocationStatePath,
  };
  const serverPath = path.join(bridgeDir, ".bigbud", "orchestration-mcp-server.mjs");
  await writeFile(serverPath, renderOrchestrationMcpServerSource(durableHttpConfig), "utf8");
  const serverName = input.serverName?.trim() || DEFAULT_ORCHESTRATION_MCP_SERVER_NAME;

  return {
    serverName,
    serverPath,
    bridgeDir,
    token,
    httpConfig: durableHttpConfig,
    cleanup: async () => {
      await deleteThreadOrchestrationToolAuth({
        stateDir: input.stateDir,
        threadId: input.threadId,
      });
      await rm(bridgeDir, { recursive: true, force: true });
    },
  };
}

export function buildCodexOrchestrationBridgeConfig(
  bridge: Pick<ThreadOrchestrationBridge, "serverName" | "serverPath" | "bridgeDir">,
): CodexOrchestrationBridgeConfig {
  return {
    serverName: bridge.serverName,
    configArgs: [
      "-c",
      `mcp_servers.${bridge.serverName}.command=${quoteTomlString(resolveNodeExecutable())}`,
      "-c",
      `mcp_servers.${bridge.serverName}.args=${quoteTomlStringArray([bridge.serverPath])}`,
      "-c",
      `mcp_servers.${bridge.serverName}.cwd=${quoteTomlString(bridge.bridgeDir)}`,
      // MCP clients filter inherited environment variables; Electron must run as Node.
      "-c",
      `mcp_servers.${bridge.serverName}.env.ELECTRON_RUN_AS_NODE=${quoteTomlString(ELECTRON_NODE_RUNTIME_ENV.ELECTRON_RUN_AS_NODE)}`,
    ],
  };
}

export function buildClaudeOrchestrationBridgeConfig(
  bridge: Pick<ThreadOrchestrationBridge, "serverName" | "serverPath">,
): ClaudeOrchestrationBridgeConfig {
  return {
    mcpServers: {
      [bridge.serverName]: {
        command: resolveNodeExecutable(),
        args: [bridge.serverPath],
        env: { ...ELECTRON_NODE_RUNTIME_ENV },
      },
    },
    allowedTools: [
      ...AGENT_WORKSPACE_TOOL_NAMES.map((name) => `mcp__${bridge.serverName}__${name}`),
      `mcp__${bridge.serverName}__browser`,
      `mcp__${bridge.serverName}__computer_use`,
      `mcp__${bridge.serverName}__rename_thread`,
      `mcp__${bridge.serverName}__archive_thread`,
      `mcp__${bridge.serverName}__send_thread_message`,
      `mcp__${bridge.serverName}__get_thread_status`,
      `mcp__${bridge.serverName}__list_threads`,
      `mcp__${bridge.serverName}__list_pinned_threads`,
      `mcp__${bridge.serverName}__pin_thread`,
      `mcp__${bridge.serverName}__unpin_thread`,
    ],
  };
}

export function buildOpencodeOrchestrationBridgeConfig(
  bridge: Pick<ThreadOrchestrationBridge, "serverName" | "serverPath"> & {
    readonly bridgeDir?: string;
  },
): OpencodeOrchestrationBridgeConfig {
  return {
    name: bridge.serverName,
    config: {
      type: "local",
      command: [resolveNodeExecutable(), bridge.serverPath],
      ...(bridge.bridgeDir ? { cwd: bridge.bridgeDir } : {}),
      environment: { ...ELECTRON_NODE_RUNTIME_ENV },
      enabled: true,
      timeout: OPENCODE_ORCHESTRATION_MCP_TOOL_TIMEOUT_MS,
    },
  };
}

export function buildAcpOrchestrationBridgeConfig(
  bridge: Pick<ThreadOrchestrationBridge, "serverName" | "serverPath">,
): AcpOrchestrationBridgeConfig {
  return {
    mcpServers: [
      {
        name: bridge.serverName,
        command: resolveNodeExecutable(),
        args: [bridge.serverPath],
        env: [
          {
            name: "ELECTRON_RUN_AS_NODE",
            value: ELECTRON_NODE_RUNTIME_ENV.ELECTRON_RUN_AS_NODE,
          },
        ],
      },
    ],
  };
}

export function mergeCodexConfigArgs(
  base: ReadonlyArray<string> | undefined,
  orchestration: CodexOrchestrationBridgeConfig,
): ReadonlyArray<string> {
  return [...(base ?? []), ...orchestration.configArgs];
}

export function mergeClaudeQueryOptions<
  T extends {
    readonly mcpServers?: Record<
      string,
      { readonly command: string; readonly args: ReadonlyArray<string> }
    >;
    readonly allowedTools?: ReadonlyArray<string>;
  },
>(base: T, orchestration: ClaudeOrchestrationBridgeConfig): T {
  return {
    ...base,
    mcpServers: base.mcpServers
      ? {
          ...base.mcpServers,
          ...orchestration.mcpServers,
        }
      : orchestration.mcpServers,
    allowedTools: [...(base.allowedTools ?? []), ...orchestration.allowedTools],
  };
}
