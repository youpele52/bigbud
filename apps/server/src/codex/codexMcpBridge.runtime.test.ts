import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCodexRemoteWorkspaceBridge } from "./codexRemoteWorkspaceBridge.ts";
import { buildCodexOrchestrationBridgeConfig } from "../orchestration-tools/orchestrationMcpBridge.ts";
import { renderOrchestrationMcpServerSource } from "../orchestration-tools/orchestrationMcpBridge.template.ts";

afterEach(() => vi.unstubAllEnvs());

describe("Codex MCP child runtime", () => {
  it.each(["workspace", "orchestration"] as const)(
    "keeps the %s bridge alive with a filtered client environment",
    async (kind) => {
      // Set this to an Electron Helper to exercise the desktop runtime as well as Node in CI.
      vi.stubEnv(
        "BIGBUD_NODE_EXECUTABLE",
        process.env.BIGBUD_TEST_NODE_EXECUTABLE || process.execPath,
      );
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "bigbud-mcp-runtime-"));
      const httpConfig = { host: "127.0.0.1", port: 1, threadId: "test", token: "fixture" };
      let cleanup: (() => Promise<void>) | undefined;
      try {
        let configArgs: ReadonlyArray<string>;
        const serverName =
          kind === "workspace" ? "bigbud_remote_workspace" : "bigbud_orchestration";
        if (kind === "workspace") {
          const bridge = await createCodexRemoteWorkspaceBridge(
            { location: "remote", executionTargetId: "ssh:host=fixture", cwd: "/root" },
            httpConfig,
            async () => ({ os: "linux", architecture: "x86_64" }),
          );
          configArgs = bridge.configArgs;
          cleanup = bridge.cleanup;
        } else {
          const serverPath = path.join(root, "bridge.mjs");
          await fs.writeFile(serverPath, renderOrchestrationMcpServerSource(httpConfig));
          configArgs = buildCodexOrchestrationBridgeConfig({
            serverName,
            serverPath,
            bridgeDir: root,
          }).configArgs;
        }
        const setting = (key: string): unknown => {
          const prefix = `mcp_servers.${serverName}.${key}=`;
          const value = configArgs.find((arg) => arg.startsWith(prefix));
          if (!value) throw new Error(`Missing MCP setting: ${key}`);
          return JSON.parse(value.slice(prefix.length));
        };
        const child = spawn(setting("command") as string, setting("args") as string[], {
          cwd: setting("cwd") as string,
          // Do not inherit ELECTRON_RUN_AS_NODE from Vitest/the desktop server.
          env: {
            PATH: process.env.PATH,
            ELECTRON_RUN_AS_NODE: setting("env.ELECTRON_RUN_AS_NODE") as string,
          },
          stdio: "pipe",
        });
        const closed = once(child, "close");
        const lines = createInterface({ input: child.stdout });
        let stderr = "";
        child.stderr.on("data", (data) => {
          stderr += String(data);
        });
        const request = async (id: number, method: string) => {
          const response = once(lines, "line", { signal: AbortSignal.timeout(5_000) });
          child.stdin.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              method,
              params: { protocolVersion: "2025-06-18" },
            }) + "\n",
          );
          return JSON.parse((await response)[0] as string);
        };
        try {
          expect(await request(1, "initialize")).toMatchObject({
            id: 1,
            result: { capabilities: { tools: {} } },
          });
          // The incident helpers initialized successfully, then crashed during GPU startup.
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          expect(child.exitCode, stderr).toBeNull();
          expect(child.signalCode, stderr).toBeNull();
          expect(await request(2, "tools/list")).toMatchObject({
            id: 2,
            result: { tools: expect.any(Array) },
          });
          expect((await request(3, "tools/list")).result.tools.length).toBeGreaterThan(0);
          expect(stderr).not.toContain("GPU process");
        } finally {
          lines.close();
          child.kill();
          await closed;
        }
      } finally {
        await cleanup?.();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
