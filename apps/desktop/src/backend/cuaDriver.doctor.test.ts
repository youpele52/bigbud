import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CUA_DRIVER_POLICY_SHA256,
  CUA_DRIVER_POLICY_VERSION,
  CUA_DRIVER_POLICY_YAML,
} from "@bigbud/shared/cua-driver/policy";
import { CUA_DRIVER_VERSION } from "@bigbud/shared/cua-driver/release";

vi.mock("electron", () => ({ app: { isPackaged: false } }));

vi.mock("./cuaDriver.daemon", () => ({
  getCuaDriverDaemonEnvironment: vi.fn(),
  getCuaDriverDaemonStatus: vi.fn(),
  refreshCuaDriverDaemonHealth: vi.fn(),
}));

vi.mock("./cuaDriver.process", () => ({
  runCommand: vi.fn(),
}));

import { runComputerUseDoctor } from "./cuaDriver";
import { getCuaDriverDaemonStatus, refreshCuaDriverDaemonHealth } from "./cuaDriver.daemon";
import { resolveManagedPaths } from "./cuaDriver.paths";
import { runCommand } from "./cuaDriver.process";

const temporaryDirectories: string[] = [];
const mockedGetDaemonStatus = vi.mocked(getCuaDriverDaemonStatus);
const mockedRefreshDaemonHealth = vi.mocked(refreshCuaDriverDaemonHealth);
const mockedRunCommand = vi.mocked(runCommand);

beforeEach(() => {
  mockedGetDaemonStatus.mockReset();
  mockedRefreshDaemonHealth.mockReset();
  mockedRunCommand.mockReset();
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("runComputerUseDoctor", () => {
  it("reports active daemon health without running standalone doctor", async () => {
    const baseDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "bigbud-cua-doctor-"));
    temporaryDirectories.push(baseDir);
    const managedPaths = resolveManagedPaths(baseDir);
    const runtimeDir = Path.join(managedPaths.versionsDir, "active");
    const binaryPath = Path.join(runtimeDir, "bin", "cua-driver");
    const policyPath = Path.join(runtimeDir, "policy", "bigbud.yaml");
    FS.mkdirSync(Path.dirname(binaryPath), { recursive: true });
    FS.mkdirSync(Path.dirname(policyPath), { recursive: true });
    FS.writeFileSync(binaryPath, "");
    FS.writeFileSync(policyPath, CUA_DRIVER_POLICY_YAML);
    FS.mkdirSync(Path.dirname(managedPaths.activePath), { recursive: true });
    FS.writeFileSync(
      managedPaths.activePath,
      JSON.stringify({
        binaryPath,
        policyPath,
        policyVersion: CUA_DRIVER_POLICY_VERSION,
        policySha256: CUA_DRIVER_POLICY_SHA256,
      }),
    );
    mockedRunCommand.mockResolvedValue({
      code: 0,
      stdout: `cua-driver ${CUA_DRIVER_VERSION}`,
      stderr: "",
    });
    mockedRefreshDaemonHealth.mockResolvedValue({
      overall: "degraded",
      diagnostics: "Accessibility permission is missing.",
      failedChecks: ["tcc_accessibility"],
      repairRequired: false,
    });
    mockedGetDaemonStatus.mockReturnValue({
      state: "degraded",
      binaryPath,
      lastError: null,
      healthSummary: "degraded",
      repairRequired: false,
    });

    await expect(runComputerUseDoctor(baseDir)).resolves.toMatchObject({
      ready: false,
      repairRequired: false,
      healthSummary: "degraded",
      message: "Computer Use health is degraded.",
      diagnostics: "Accessibility permission is missing.",
    });

    expect(mockedRefreshDaemonHealth).toHaveBeenCalledOnce();
    expect(mockedRunCommand).toHaveBeenCalledWith(binaryPath, ["--version"], expect.any(Object));
    expect(mockedRunCommand).not.toHaveBeenCalledWith(
      binaryPath,
      expect.arrayContaining(["doctor"]),
      expect.anything(),
    );
  });
});
