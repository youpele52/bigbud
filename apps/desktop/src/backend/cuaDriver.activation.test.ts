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
      .mockRejectedValueOnce(new Error("Permission denied: policy blocked kill_app"));

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
