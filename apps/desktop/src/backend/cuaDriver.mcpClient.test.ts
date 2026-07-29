import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CUA_DRIVER_REQUIRED_TOOLS } from "@bigbud/shared/cua-driver/policy";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

import * as ChildProcess from "node:child_process";
import { callCuaDriverTool, stopCuaDriverMcpClient } from "./cuaDriver.mcpClient";

const mockedSpawn = vi.mocked(ChildProcess.spawn);

function makeMcpChild(failOnMethod?: string) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn();
  let buffer = "";
  child.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    for (;;) {
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd === -1) break;
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);
      if (!line) continue;
      const request = JSON.parse(line) as { id?: number; method: string };
      if (request.id === undefined) continue;
      if (request.method === failOnMethod) {
        queueMicrotask(() => child.emit("error", new Error(`failed ${request.method}`)));
        continue;
      }
      const result =
        request.method === "tools/list"
          ? { tools: CUA_DRIVER_REQUIRED_TOOLS.map((name) => ({ name })) }
          : request.method === "tools/call"
            ? { structuredContent: { overall: "ready" } }
            : {};
      child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    }
  });
  return child;
}

describe("callCuaDriverTool", () => {
  beforeEach(() => {
    stopCuaDriverMcpClient();
    mockedSpawn.mockReset();
  });

  it("reuses one supported MCP bridge process for daemon-backed calls", async () => {
    mockedSpawn.mockReturnValue(makeMcpChild() as never);
    const options = {
      socketPath: "/tmp/bigbud-cua-test.sock",
      environment: { BIGBUD_CUA_HOST_BUNDLE_ID: "ai.bigbud.desktop.dev" },
    };

    const first = await callCuaDriverTool("/tmp/cua-driver", "health_report", {}, options);
    const second = await callCuaDriverTool("/tmp/cua-driver", "check_permissions", {}, options);

    expect(first).toEqual({ structuredContent: { overall: "ready" } });
    expect(second).toEqual({ structuredContent: { overall: "ready" } });
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    expect(mockedSpawn).toHaveBeenCalledWith(
      "/tmp/cua-driver",
      expect.arrayContaining(["mcp", "--embedded", "--socket", "/tmp/bigbud-cua-test.sock"]),
      expect.objectContaining({ shell: false }),
    );
  });

  it("discards a broken persistent bridge before retrying", async () => {
    const broken = makeMcpChild("initialize");
    const healthy = makeMcpChild();
    mockedSpawn.mockReturnValueOnce(broken as never).mockReturnValueOnce(healthy as never);
    const options = {
      socketPath: "/tmp/bigbud-cua-retry.sock",
      timeoutMs: 100,
      environment: { BIGBUD_CUA_HOST_BUNDLE_ID: "ai.bigbud.desktop.dev" },
    };

    await expect(
      callCuaDriverTool("/tmp/cua-driver", "health_report", {}, options),
    ).rejects.toThrow("failed initialize");
    await expect(
      callCuaDriverTool("/tmp/cua-driver", "health_report", {}, options),
    ).resolves.toEqual({ structuredContent: { overall: "ready" } });

    expect(broken.kill).toHaveBeenCalledWith("SIGTERM");
    expect(mockedSpawn).toHaveBeenCalledTimes(2);
  });

  it("stops the persistent bridge explicitly", async () => {
    const child = makeMcpChild();
    mockedSpawn.mockReturnValue(child as never);
    await callCuaDriverTool(
      "/tmp/cua-driver",
      "health_report",
      {},
      {
        socketPath: "/tmp/bigbud-cua-stop.sock",
        environment: { BIGBUD_CUA_HOST_BUNDLE_ID: "ai.bigbud.desktop.dev" },
      },
    );

    stopCuaDriverMcpClient();

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
