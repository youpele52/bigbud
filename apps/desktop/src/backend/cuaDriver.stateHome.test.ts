import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runCommand: vi.fn(
    async (_binary: string, _args: ReadonlyArray<string>, _env: Record<string, string>) => ({
      code: 0,
      stdout: "",
      stderr: "",
    }),
  ),
}));

vi.mock("electron", () => ({ app: { isPackaged: false } }));
vi.mock("./cuaDriver.process", () => ({
  runCommand: mocks.runCommand,
  stopCuaDriverCommandsAndWait: vi.fn(async () => undefined),
}));
vi.mock("./cuaDriver.runtime", () => ({
  resolveComputerUseRuntime: vi.fn(() => ({
    source: "managed",
    binaryPath: "/managed/cua-driver",
    policyPath: null,
    version: null,
  })),
}));
vi.mock("./cuaDriver.daemon", () => ({
  getCuaDriverDaemonEnvironment: vi.fn(() => undefined),
  getCuaDriverDaemonStatus: vi.fn(() => ({
    state: "stopped",
    binaryPath: null,
    lastError: null,
    healthSummary: null,
    repairRequired: true,
  })),
  refreshCuaDriverDaemonHealth: vi.fn(),
}));

import { getComputerUseRuntimeStatus } from "./cuaDriver";
import { validateCuaDriverRuntime } from "./cuaDriver.manifest";
import { resolveManagedPaths, resolvePrivateStateHome } from "./cuaDriver.paths";

const directories: string[] = [];
function baseDir(): string {
  const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "bigbud-cua-state-"));
  directories.push(directory);
  return directory;
}

beforeEach(() => {
  mocks.runCommand.mockClear();
});

afterEach(() => {
  for (const directory of directories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("private Driver state home", () => {
  it.skipIf(process.platform === "win32")(
    "tightens a home dir an earlier install created with the default mode",
    () => {
      const base = baseDir();
      const homeDir = resolveManagedPaths(base).homeDir;
      FS.mkdirSync(homeDir, { recursive: true, mode: 0o755 });
      FS.chmodSync(homeDir, 0o755);

      expect(resolvePrivateStateHome(base)).toBe(homeDir);
      expect(FS.statSync(homeDir).mode & 0o777).toBe(0o700);
    },
  );

  it("runs the status manifest probe with the private state home", async () => {
    const base = baseDir();
    await getComputerUseRuntimeStatus(base);

    const [, args, env] = mocks.runCommand.mock.calls[0]!;
    const homeDir = resolveManagedPaths(base).homeDir;
    expect(args).toEqual(["manifest"]);
    expect(env).toMatchObject({
      BIGBUD_CUA_STATE_HOME: homeDir,
      CUA_DRIVER_RS_HOME: homeDir,
      CUA_DRIVER_TELEMETRY_HOME: homeDir,
    });
  });

  it("runs the install-time `manifest` validation with the private state home", async () => {
    mocks.runCommand.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "stop here" });
    await expect(
      validateCuaDriverRuntime("/managed/cua-driver", undefined, "/state-home"),
    ).rejects.toThrow("stop here");

    const [, args, env] = mocks.runCommand.mock.calls[0]!;
    expect(args).toEqual(["manifest"]);
    expect(env).toMatchObject({
      CUA_DRIVER_RS_HOME: "/state-home",
      CUA_DRIVER_TELEMETRY_HOME: "/state-home",
    });
  });
});
