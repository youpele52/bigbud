import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  buildAcpOrchestrationBridgeConfig,
  buildClaudeOrchestrationBridgeConfig,
  buildCodexOrchestrationBridgeConfig,
  buildOpencodeOrchestrationBridgeConfig,
  createThreadOrchestrationBridge,
  mergeClaudeQueryOptions,
  mergeCodexConfigArgs,
} from "./orchestrationMcpBridge.ts";
import { renderOrchestrationMcpServerSource } from "./orchestrationMcpBridge.template.ts";
import {
  createThreadOrchestrationToolToken,
  isThreadOrchestrationToolAuthorized,
  readThreadOrchestrationToolAuthByToken,
  readThreadOrchestrationToolAuth,
  writeThreadOrchestrationToolAuth,
} from "./ThreadOrchestrationToolAuth.ts";

function parseMcpMessages(buffer: Buffer): Array<unknown> {
  const messages: unknown[] = [];
  let remaining = buffer;
  while (true) {
    const headerEnd = remaining.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      const newlineIndex = remaining.indexOf("\n");
      if (newlineIndex === -1) return messages;
      const line = remaining.subarray(0, newlineIndex).toString("utf8").trim();
      if (line.length > 0) {
        messages.push(JSON.parse(line) as unknown);
      }
      remaining = remaining.subarray(newlineIndex + 1);
      continue;
    }
    const header = remaining.subarray(0, headerEnd).toString("utf8");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) return messages;
    const contentLength = Number(match[1]);
    const totalLength = headerEnd + 4 + contentLength;
    if (remaining.length < totalLength) return messages;
    messages.push(
      JSON.parse(remaining.subarray(headerEnd + 4, totalLength).toString("utf8")) as unknown,
    );
    remaining = remaining.subarray(totalLength);
  }
}

describe("orchestrationMcpBridge", () => {
  it("renders an MCP server that calls the internal thread-tools endpoint", () => {
    const source = renderOrchestrationMcpServerSource({
      host: "127.0.0.1",
      port: 3773,
      threadId: "thread-1",
      token: "token-1",
    });

    expect(source).toContain("/api/internal/thread-tools");
    expect(source).toContain("computer_use");
    expect(source).toContain("rename_thread");
    expect(source).toContain("archive_thread");
    expect(source).toContain("get_thread_status");
    expect(source).toContain("token-1");
    expect(source).toContain("action: 'get_status'");
  });

  it("accepts newline-delimited JSON-RPC messages from OpenCode", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bigbud-opencode-mcp-"));
    const serverPath = path.join(tempDir, "orchestration-mcp-server.mjs");
    await fs.writeFile(
      serverPath,
      renderOrchestrationMcpServerSource({
        host: "127.0.0.1",
        port: 3773,
        threadId: "thread-1",
        token: "token-1",
      }),
      "utf8",
    );

    const child = spawn(process.execPath, [serverPath], {
      cwd: tempDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

    const readMessages = async () => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < 2_000) {
        const messages = parseMcpMessages(Buffer.concat(chunks));
        if (messages.length >= 2) return messages;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("Timed out waiting for generated MCP server responses.");
    };

    try {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: { roots: {} },
            clientInfo: { name: "opencode", version: "1.17.13" },
          },
        })}\n`,
      );
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        })}\n`,
      );

      const messages = await readMessages();
      expect(messages[0]).toMatchObject({
        id: 1,
        result: {
          protocolVersion: "2025-11-25",
          serverInfo: { name: "bigbud-orchestration" },
        },
      });
      expect(messages[1]).toMatchObject({
        id: 2,
        result: {
          tools: expect.arrayContaining([
            expect.objectContaining({ name: "rename_thread" }),
            expect.objectContaining({ name: "computer_use" }),
          ]),
        },
      });
    } finally {
      child.kill();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
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
        "mcp__bigbud_orchestration__computer_use",
        "mcp__bigbud_orchestration__rename_thread",
        "mcp__bigbud_orchestration__get_thread_status",
      ]),
    );
    expect((merged.mcpServers as Record<string, unknown>)["bigbud_orchestration"]).toBeDefined();
    expect(merged.mcpServers?.existing).toBeDefined();
  });

  it("builds OpenCode MCP config for orchestration tools", () => {
    const bridge = {
      serverName: "bigbud_orchestration" as const,
      serverPath: "/tmp/orchestration-mcp-server.mjs",
      bridgeDir: "/tmp/bridge",
      token: "token-1",
      cleanup: async () => undefined,
    };

    expect(buildOpencodeOrchestrationBridgeConfig(bridge)).toEqual({
      name: "bigbud_orchestration",
      config: {
        type: "local",
        command: [process.execPath, bridge.serverPath],
        cwd: bridge.bridgeDir,
        enabled: true,
        timeout: 10_000,
      },
    });
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
      expect(
        await readThreadOrchestrationToolAuth({
          stateDir,
          threadId: "thread-1",
        }),
      ).toBeNull();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects expired thread tool auth records", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "bigbud-thread-tool-auth-"));
    await writeThreadOrchestrationToolAuth({
      stateDir,
      threadId: "thread-expired",
      token: "token-expired",
    });
    const filePath = path.join(stateDir, "thread-tool-auth", "thread-expired.json");
    await fs.writeFile(
      filePath,
      JSON.stringify({
        threadId: "thread-expired",
        token: "token-expired",
        createdAt: "2020-01-01T00:00:00.000Z",
      }),
      "utf8",
    );

    try {
      const record = await readThreadOrchestrationToolAuth({
        stateDir,
        threadId: "thread-expired",
      });
      expect(
        isThreadOrchestrationToolAuthorized({
          record,
          threadId: "thread-expired",
          token: "token-expired",
        }),
      ).toBe(false);
      expect(
        await readThreadOrchestrationToolAuthByToken({
          stateDir,
          token: "token-expired",
        }),
      ).toBeNull();
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
