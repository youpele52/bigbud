import * as FS from "node:fs";
import * as Path from "node:path";
import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

vi.mock("./cuaDriver.mcpClient", () => ({
  callCuaDriverTool: vi.fn(),
}));

vi.mock("./cuaDriver.process", () => ({
  runCommand: vi.fn(),
}));

import * as ChildProcess from "node:child_process";
import { cuaDriverHonoursPidFile } from "@bigbud/shared/cua-driver/invocation";
import { CUA_DRIVER_VERSION } from "@bigbud/shared/cua-driver/release";
import {
  createCuaDriverValidationEndpoint,
  validateCuaDriverActivation,
} from "./cuaDriver.activation";
import { callCuaDriverTool } from "./cuaDriver.mcpClient";
import { runCommand } from "./cuaDriver.process";

const cleanupDirectories: string[] = [];
const mockedCallCuaDriverTool = vi.mocked(callCuaDriverTool);
const mockedRunCommand = vi.mocked(runCommand);
const mockedSpawn = vi.mocked(ChildProcess.spawn);

function makeValidationChild() {
  const child = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn();
  return child;
}

beforeEach(() => {
  mockedCallCuaDriverTool.mockReset();
  mockedRunCommand.mockReset();
  mockedSpawn.mockReset();
});

afterEach(() => {
  for (const directory of cleanupDirectories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
});

const probeInput = {
  binaryPath: "/tmp/cua-driver",
  policyPath: "/tmp/bigbud.yaml",
  hostBundleId: "ai.bigbud.desktop.dev",
};

describe("Computer Use activation endpoint", () => {
  it.skipIf(process.platform === "win32")(
    "uses a short private Unix socket path outside the versioned runtime directory",
    () => {
      const endpoint = createCuaDriverValidationEndpoint();
      cleanupDirectories.push(endpoint.cleanupDirectory!);

      expect(endpoint.endpoint).toMatch(/^\/tmp\/bigbud-cua-validation-[^/]+\/cua\.sock$/);
      expect(Buffer.byteLength(endpoint.endpoint)).toBeLessThan(104);
      expect(FS.statSync(endpoint.cleanupDirectory!).mode & 0o777).toBe(0o700);
      expect(Path.dirname(endpoint.endpoint)).toBe(endpoint.cleanupDirectory);
    },
  );

  it("validates health and policy without requiring host permissions", async () => {
    const child = makeValidationChild();
    mockedSpawn.mockReturnValue(child as never);
    mockedRunCommand.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    mockedCallCuaDriverTool
      .mockResolvedValueOnce({ structuredContent: { overall: "degraded" } })
      .mockRejectedValueOnce(new Error("Permission denied: tool 'kill_app' is explicitly denied"));

    await expect(
      validateCuaDriverActivation({
        binaryPath: "/tmp/cua-driver",
        policyPath: "/tmp/bigbud.yaml",
        hostBundleId: "ai.bigbud.desktop.dev",
      }),
    ).resolves.toBeUndefined();

    expect(mockedSpawn).toHaveBeenCalledWith(
      "/tmp/cua-driver",
      expect.arrayContaining([
        "serve",
        "--embedded",
        "--host-bundle-id",
        "ai.bigbud.desktop.dev",
        "--no-permissions-gate",
        "--no-overlay",
      ]),
      expect.objectContaining({ shell: false }),
    );
    expect(mockedCallCuaDriverTool.mock.calls.map(([, name]) => name)).toEqual([
      "health_report",
      "kill_app",
    ]);
    expect(mockedCallCuaDriverTool).not.toHaveBeenCalledWith(
      expect.anything(),
      "check_permissions",
      expect.anything(),
      expect.anything(),
    );
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it.each([
    ["0.9.1 JSON-RPC denial", "Permission denied: tool 'kill_app' is explicitly denied"],
    [
      "0.38 tool-error denial",
      "Permission denied: user policy: tool 'kill_app' is explicitly denied",
    ],
  ])(
    "accepts the %s and calls the probe without requiring it to be listed",
    async (_label, text) => {
      mockedSpawn.mockReturnValue(makeValidationChild() as never);
      mockedRunCommand.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
      mockedCallCuaDriverTool
        .mockResolvedValueOnce({ structuredContent: { overall: "ready" } })
        .mockRejectedValueOnce(new Error(text));
      await expect(validateCuaDriverActivation(probeInput)).resolves.toBeUndefined();
      expect(mockedCallCuaDriverTool).toHaveBeenLastCalledWith(
        "/tmp/cua-driver",
        "kill_app",
        {},
        expect.objectContaining({ allowUnadvertisedTool: true }),
      );
      // Only the probe may bypass the advertise check.
      expect(mockedCallCuaDriverTool.mock.calls[0]?.[3]).not.toHaveProperty(
        "allowUnadvertisedTool",
      );
    },
  );

  it.each([
    ["an unknown-tool error", () => Promise.reject(new Error("Unknown tool: kill_app"))],
    ["a successful probe", () => Promise.resolve({ structuredContent: {} })],
  ])("fails activation on %s", async (_label, probe) => {
    mockedSpawn.mockReturnValue(makeValidationChild() as never);
    mockedRunCommand.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    mockedCallCuaDriverTool
      .mockResolvedValueOnce({ structuredContent: { overall: "ready" } })
      .mockImplementationOnce(probe);
    await expect(validateCuaDriverActivation(probeInput)).rejects.toThrow();
  });
});

describe("Computer Use activation isolation", () => {
  it("gives the validation daemon a throwaway state home and pid file next to its socket", () => {
    const endpoint = createCuaDriverValidationEndpoint();
    cleanupDirectories.push(endpoint.cleanupDirectory);

    expect(Path.dirname(endpoint.pidFile)).toBe(endpoint.cleanupDirectory);
    expect(Path.dirname(endpoint.stateHome)).toBe(endpoint.cleanupDirectory);
    expect(FS.statSync(endpoint.stateHome).isDirectory()).toBe(true);
  });

  it("runs the validation daemon with the private state env and a version-gated pid file", async () => {
    mockedSpawn.mockReturnValue(makeValidationChild() as never);
    mockedRunCommand.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    mockedCallCuaDriverTool
      .mockResolvedValueOnce({ structuredContent: { overall: "ready" } })
      .mockRejectedValueOnce(new Error("Permission denied: tool 'kill_app' is explicitly denied"));
    await expect(validateCuaDriverActivation(probeInput)).resolves.toBeUndefined();

    const [, args, options] = mockedSpawn.mock.calls[0]! as unknown as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    const stateHome = options.env.CUA_DRIVER_RS_HOME!;
    expect(stateHome).toMatch(/bigbud-cua-validation-[^/]+\/state$/);
    expect(options.env.CUA_DRIVER_TELEMETRY_HOME).toBe(stateHome);
    expect(options.env.BIGBUD_CUA_STATE_HOME).toBe(stateHome);
    expect(options.env.HOME).toBe(process.env.HOME);
    // The validation daemon runs the pinned version: 0.38 gets `--pid-file` inside the
    // same throwaway directory; 0.9.1 ignores the flag upstream, so its argv is unchanged.
    const pidIndex = args.indexOf("--pid-file");
    if (cuaDriverHonoursPidFile(CUA_DRIVER_VERSION)) {
      expect(Path.dirname(args[pidIndex + 1]!)).toBe(Path.dirname(stateHome));
    } else {
      expect(pidIndex).toBe(-1);
    }
    // Every helper command (status, tools) sees the same private state home.
    expect(mockedRunCommand.mock.calls[0]?.[2]).toMatchObject({ CUA_DRIVER_RS_HOME: stateHome });
    expect(mockedCallCuaDriverTool.mock.calls[0]?.[3]?.environment).toMatchObject({
      CUA_DRIVER_RS_HOME: stateHome,
    });
  });
});

// Last: quiescence is process-wide and cannot be undone within this file.
describe("Computer Use activation after update quiescence", () => {
  it("refuses activation validation after update quiescence begins", async () => {
    const { beginInstalledProcessQuiescence } = await import("./installedProcessQuiescence");
    beginInstalledProcessQuiescence();

    await expect(
      validateCuaDriverActivation({
        binaryPath: "/tmp/cua-driver",
        policyPath: "/tmp/bigbud.yaml",
        hostBundleId: "ai.bigbud.desktop.dev",
      }),
    ).rejects.toThrow("cannot start while update installation is preparing");
    expect(mockedSpawn).not.toHaveBeenCalled();
  });
});
