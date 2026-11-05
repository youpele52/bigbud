import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as FS from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CUA_DRIVER_REQUIRED_TOOLS } from "@bigbud/shared/cua-driver/policy";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

import * as ChildProcess from "node:child_process";
import {
  callCuaDriverTool,
  stopCuaDriverMcpClient,
  stopCuaDriverMcpClientAndWait,
} from "./cuaDriver.mcpClient";

const mockedSpawn = vi.mocked(ChildProcess.spawn);

const HOST_ENV = { BIGBUD_CUA_HOST_BUNDLE_ID: "ai.bigbud.desktop.dev" };

interface FakeDriver {
  readonly protocolVersion?: string;
  readonly toolDefinitions?: unknown[];
  readonly tools?: ReadonlyArray<string>;
  readonly callResult?: unknown;
}

function makeMcpChild(failOnMethod?: string, autoExit = true, driver: FakeDriver = {}) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 91;
  child.kill = vi.fn((signal: NodeJS.Signals) => {
    if (autoExit) {
      queueMicrotask(() => {
        child.exitCode = 0;
        child.signalCode = signal;
        child.emit("exit", 0, signal);
        child.emit("close", 0, signal);
      });
    }
    return true;
  });
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
          ? {
              tools:
                driver.toolDefinitions ??
                (driver.tools ?? CUA_DRIVER_REQUIRED_TOOLS).map((name) => ({ name })),
            }
          : request.method === "tools/call"
            ? (driver.callResult ?? { structuredContent: { overall: "ready" } })
            : { protocolVersion: driver.protocolVersion ?? "2025-06-18" };
      child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    }
  });
  return child;
}

describe("callCuaDriverTool", () => {
  beforeEach(async () => {
    await stopCuaDriverMcpClientAndWait();
    mockedSpawn.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls an unadvertised probe tool only when explicitly allowed", async () => {
    // Driver 0.38 hides policy-denied tools such as kill_app from tools/list.
    const denied = {
      isError: true,
      content: [
        {
          type: "text",
          text: "Permission denied: user policy: tool 'kill_app' is explicitly denied",
        },
      ],
    };
    const options = { socketPath: "/tmp/bigbud-cua-probe.sock", environment: HOST_ENV };
    mockedSpawn.mockReturnValue(makeMcpChild(undefined, true, { callResult: denied }) as never);
    await expect(
      callCuaDriverTool("/tmp/cua-driver", "kill_app", { name: "probe" }, options),
    ).rejects.toThrow("did not advertise tool 'kill_app'");
    await stopCuaDriverMcpClientAndWait();
    const child = makeMcpChild(undefined, true, { callResult: denied });
    const written: string[] = [];
    child.stdin.on("data", (chunk) => written.push(chunk.toString()));
    mockedSpawn.mockReturnValue(child as never);
    await expect(
      callCuaDriverTool(
        "/tmp/cua-driver",
        "kill_app",
        { name: "probe" },
        { ...options, allowUnadvertisedTool: true },
      ),
    ).rejects.toThrow("Permission denied: user policy: tool 'kill_app' is explicitly denied");
    expect(written.join("")).toContain('"method":"tools/call"');
  });

  it.each(["protocol", "schema", "compatible"])(
    "checks unfamiliar runtime %s before calling tools",
    async (mode) => {
      const fixture = JSON.parse(
        FS.readFileSync(
          new URL(
            "../../../../scripts/fixtures/cua-driver/0.38.0/live-schema.darwin.json",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      if (mode === "schema") fixture.tools.click.inputSchema.properties.x.type = "string";
      const child = makeMcpChild(undefined, true, {
        protocolVersion: mode === "protocol" ? "future" : "2025-06-18",
        toolDefinitions: Object.entries(fixture.tools).map(([name, tool]) =>
          Object.assign({ name }, tool),
        ),
      });
      const writes: string[] = [];
      child.stdin.on("data", (chunk) => writes.push(chunk.toString()));
      mockedSpawn.mockReturnValue(child as never);
      const call = callCuaDriverTool(
        "/driver",
        "health_report",
        {},
        {
          socketPath: "/strict.sock",
          environment: { ...HOST_ENV, BIGBUD_CUA_VALIDATE_MCP: "1" },
        },
      );
      if (mode === "compatible") await expect(call).resolves.toBeDefined();
      else {
        await expect(call).rejects.toThrow(mode === "protocol" ? "protocol" : "input schema");
        expect(writes.join("")).not.toContain('"tools/call"');
      }
    },
  );

  it("allows an unadvertised probe on the one-shot path but still requires every tool", async () => {
    const denied = { isError: true, content: [{ type: "text", text: "Permission denied: x" }] };
    mockedSpawn.mockReturnValue(makeMcpChild(undefined, true, { callResult: denied }) as never);
    await expect(
      callCuaDriverTool(
        "/tmp/cua-driver",
        "kill_app",
        {},
        { environment: HOST_ENV, allowUnadvertisedTool: true },
      ),
    ).rejects.toThrow("Permission denied: x");
    const partial = CUA_DRIVER_REQUIRED_TOOLS.slice(1);
    mockedSpawn.mockReturnValue(makeMcpChild(undefined, true, { tools: partial }) as never);
    await expect(
      callCuaDriverTool(
        "/tmp/cua-driver",
        "kill_app",
        {},
        { environment: HOST_ENV, allowUnadvertisedTool: true },
      ),
    ).rejects.toThrow("missing required tools");
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

  it("awaits persistent bridge exit and coalesces concurrent shutdown", async () => {
    const child = makeMcpChild(undefined, false);
    mockedSpawn.mockReturnValue(child as never);
    await callCuaDriverTool(
      "/tmp/cua-driver",
      "health_report",
      {},
      {
        socketPath: "/tmp/bigbud-cua-await-stop.sock",
        environment: { BIGBUD_CUA_HOST_BUNDLE_ID: "ai.bigbud.desktop.dev" },
      },
    );

    const first = stopCuaDriverMcpClientAndWait();
    const second = stopCuaDriverMcpClientAndWait();
    expect(second).toBe(first);
    expect(child.kill).toHaveBeenCalledTimes(1);

    child.exitCode = 0;
    child.emit("exit", 0, "SIGTERM");
    await Promise.all([first, second]);
  });

  it("propagates inability to confirm persistent bridge exit", async () => {
    vi.useFakeTimers();
    const child = makeMcpChild(undefined, false);
    mockedSpawn.mockReturnValue(child as never);
    await callCuaDriverTool(
      "/tmp/cua-driver",
      "health_report",
      {},
      {
        socketPath: "/tmp/bigbud-cua-timeout-stop.sock",
        environment: { BIGBUD_CUA_HOST_BUNDLE_ID: "ai.bigbud.desktop.dev" },
      },
    );

    const expectation = expect(stopCuaDriverMcpClientAndWait(1_000)).rejects.toThrow(
      "Could not confirm auxiliary cua-driver process shutdown",
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expectation;
    child.exitCode = 0;
    child.emit("exit", 0, "SIGTERM");
  });

  it("refuses to spawn an MCP client after update quiescence begins", async () => {
    const { beginInstalledProcessQuiescence } = await import("./installedProcessQuiescence");
    beginInstalledProcessQuiescence();

    await expect(callCuaDriverTool("/tmp/cua-driver", "health_report", {})).rejects.toThrow(
      "cannot start while update installation is preparing",
    );
    expect(mockedSpawn).not.toHaveBeenCalled();
  });
});
