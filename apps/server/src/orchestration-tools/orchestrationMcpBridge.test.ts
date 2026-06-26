import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildAcpOrchestrationBridgeConfig,
  buildClaudeOrchestrationBridgeConfig,
  buildCodexOrchestrationBridgeConfig,
  createThreadOrchestrationBridge,
  mergeClaudeQueryOptions,
  mergeCodexConfigArgs,
} from "./orchestrationMcpBridge.ts";
import { renderOrchestrationMcpServerSource } from "./orchestrationMcpBridge.template.ts";
import {
  createThreadOrchestrationToolToken,
  readThreadOrchestrationToolAuthByToken,
  readThreadOrchestrationToolAuth,
} from "./ThreadOrchestrationToolAuth.ts";

describe("orchestrationMcpBridge", () => {
  it("renders an MCP server that calls the internal thread-tools endpoint", () => {
    const source = renderOrchestrationMcpServerSource({
      host: "127.0.0.1",
      port: 3773,
      threadId: "thread-1",
      token: "token-1",
    });

    expect(source).toContain("/api/internal/thread-tools");
    expect(source).toContain("rename_thread");
    expect(source).toContain("archive_thread");
    expect(source).toContain("get_thread_status");
    expect(source).toContain("token-1");
    expect(source).toContain("action: 'get_status'");
  });

  it("merges Codex and Claude orchestration config into existing provider config", () => {
    const bridge = {
      serverName: "bigbud_orchestration" as const,
      serverPath: "/tmp/orchestration-mcp-server.mjs",
      bridgeDir: "/tmp/bridge",
      token: "token-1",
      cleanup: async () => undefined,
    };

    const codex = buildCodexOrchestrationBridgeConfig(bridge);
    expect(mergeCodexConfigArgs(["-c", "foo=bar"], codex)).toEqual(
      expect.arrayContaining(["-c", "foo=bar", ...codex.configArgs]),
    );

    const claude = buildClaudeOrchestrationBridgeConfig(bridge);
    const merged = mergeClaudeQueryOptions(
      {
        allowedTools: ["Read"],
        mcpServers: {
          existing: { command: "node", args: ["existing.mjs"] },
        },
      },
      claude,
    );
    expect(merged.allowedTools).toEqual(
      expect.arrayContaining([
        "Read",
        "mcp__bigbud_orchestration__rename_thread",
        "mcp__bigbud_orchestration__get_thread_status",
      ]),
    );
    expect((merged.mcpServers as Record<string, unknown>)["bigbud_orchestration"]).toBeDefined();
    expect(merged.mcpServers?.existing).toBeDefined();
  });

  it("builds ACP stdio MCP config for orchestration tools", () => {
    const bridge = {
      serverName: "bigbud_orchestration" as const,
      serverPath: "/tmp/orchestration-mcp-server.mjs",
      bridgeDir: "/tmp/bridge",
      token: "token-1",
      cleanup: async () => undefined,
    };

    const acp = buildAcpOrchestrationBridgeConfig(bridge);
    expect(acp.mcpServers).toEqual([
      {
        name: "bigbud_orchestration",
        command: process.execPath,
        args: [bridge.serverPath],
        env: [],
      },
    ]);
  });

  it("writes per-thread auth records when creating a bridge", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "bigbud-thread-tool-auth-"));
    const bridge = await createThreadOrchestrationBridge({
      stateDir,
      threadId: "thread-1",
      host: "127.0.0.1",
      port: 3773,
    });

    try {
      const auth = await readThreadOrchestrationToolAuth({
        stateDir,
        threadId: "thread-1",
      });
      expect(auth?.threadId).toBe("thread-1");
      expect(auth?.token).toBe(bridge.token);
      expect(
        await readThreadOrchestrationToolAuthByToken({
          stateDir,
          token: bridge.token,
        }),
      ).toEqual(auth);
      expect(createThreadOrchestrationToolToken()).not.toBe(bridge.token);
    } finally {
      await bridge.cleanup();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
