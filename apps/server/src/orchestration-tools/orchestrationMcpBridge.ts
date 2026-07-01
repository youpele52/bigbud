import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_ORCHESTRATION_MCP_SERVER_NAME } from "./orchestrationMcpBridge.template.shared.ts";
import { renderOrchestrationMcpServerSource } from "./orchestrationMcpBridge.template.ts";
import { deleteThreadOrchestrationToolAuth } from "./ThreadOrchestrationToolAuth.ts";
import {
  prepareThreadOrchestrationSessionAuth,
  resolveThreadOrchestrationHttpConfig,
} from "./threadOrchestrationBridge.shared.ts";

export interface ThreadOrchestrationBridgeInput {
  readonly stateDir: string;
  readonly threadId: string;
  readonly host: string | undefined;
  readonly port: number;
  readonly serverName?: string;
}

export interface ThreadOrchestrationBridge {
  readonly serverName: string;
  readonly serverPath: string;
  readonly bridgeDir: string;
  readonly token: string;
  readonly cleanup: () => Promise<void>;
}

export interface CodexOrchestrationBridgeConfig {
  readonly configArgs: ReadonlyArray<string>;
}

export interface ClaudeOrchestrationBridgeConfig {
  readonly mcpServers: Record<
    string,
    {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
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
  };
}

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
  await mkdir(path.join(bridgeDir, ".bigbud"), { recursive: true });
  const serverPath = path.join(bridgeDir, ".bigbud", "orchestration-mcp-server.mjs");
  await writeFile(serverPath, renderOrchestrationMcpServerSource(httpConfig), "utf8");
  const serverName = input.serverName?.trim() || DEFAULT_ORCHESTRATION_MCP_SERVER_NAME;

  return {
    serverName,
    serverPath,
    bridgeDir,
    token,
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
    configArgs: [
      "-c",
      `mcp_servers.${bridge.serverName}.command=${quoteTomlString(process.execPath)}`,
      "-c",
      `mcp_servers.${bridge.serverName}.args=${quoteTomlStringArray([bridge.serverPath])}`,
      "-c",
      `mcp_servers.${bridge.serverName}.cwd=${quoteTomlString(bridge.bridgeDir)}`,
    ],
  };
}

export function buildClaudeOrchestrationBridgeConfig(
  bridge: Pick<ThreadOrchestrationBridge, "serverName" | "serverPath">,
): ClaudeOrchestrationBridgeConfig {
  return {
    mcpServers: {
      [bridge.serverName]: {
        command: process.execPath,
        args: [bridge.serverPath],
      },
    },
    allowedTools: [
      `mcp__${bridge.serverName}__computer_use`,
      `mcp__${bridge.serverName}__rename_thread`,
      `mcp__${bridge.serverName}__archive_thread`,
      `mcp__${bridge.serverName}__get_thread_status`,
    ],
  };
}

export function buildOpencodeOrchestrationBridgeConfig(
  bridge: Pick<ThreadOrchestrationBridge, "serverName" | "serverPath">,
): OpencodeOrchestrationBridgeConfig {
  return {
    name: bridge.serverName,
    config: {
      type: "local",
      command: [process.execPath, bridge.serverPath],
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
        command: process.execPath,
        args: [bridge.serverPath],
        env: [],
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
