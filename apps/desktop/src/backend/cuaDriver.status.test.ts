import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false } }));
vi.mock("./cuaDriver.runtime", () => ({ resolveComputerUseRuntime: vi.fn() }));
vi.mock("./cuaDriver.manifest", () => ({ validateCuaDriverRuntime: vi.fn() }));
vi.mock("./cuaDriver.paths", () => ({ resolvePrivateStateHome: vi.fn(() => "/state") }));
vi.mock("./cuaDriver.daemon", () => ({
  getCuaDriverDaemonStatus: vi.fn(),
  getCuaDriverDaemonEnvironment: vi.fn(),
  refreshCuaDriverDaemonHealth: vi.fn(),
}));

import { getComputerUseRuntimeStatus, runComputerUseDoctor } from "./cuaDriver";
import { cuaDriverRuntimeKey, setCuaDriverStartupFailure } from "./cuaDriver.startupFailure";
import { resolveComputerUseRuntime } from "./cuaDriver.runtime";
import { validateCuaDriverRuntime } from "./cuaDriver.manifest";
import { getCuaDriverDaemonStatus } from "./cuaDriver.daemon";

beforeEach(() => {
  vi.resetAllMocks();
  setCuaDriverStartupFailure("", null);
  vi.mocked(resolveComputerUseRuntime).mockReturnValue({
    source: "managed",
    binaryPath: "/driver",
    policyPath: "/policy",
    version: "0.39.0",
  });
  vi.mocked(validateCuaDriverRuntime).mockResolvedValue({
    schema_version: "1",
    binary_version: "0.39.0",
    binary_path: "/driver",
    mcp_invocation: { command: "/driver", args: ["mcp"] },
  });
  vi.mocked(getCuaDriverDaemonStatus).mockReturnValue({
    state: "ready",
    binaryPath: "/driver",
    lastError: null,
    healthSummary: "ok",
    repairRequired: false,
  });
});

describe("compatible runtime status", () => {
  it("surfaces preflight failures in status and doctor, but not another runtime", async () => {
    setCuaDriverStartupFailure(
      cuaDriverRuntimeKey("/base", "/driver", "/policy"),
      "missing --embedded",
    );
    await expect(getComputerUseRuntimeStatus("/base")).resolves.toMatchObject({
      state: "incompatible",
      ready: false,
      lastError: "missing --embedded",
    });
    await expect(runComputerUseDoctor("/base")).resolves.toMatchObject({
      message: "missing --embedded",
      diagnostics: "missing --embedded",
    });
    await expect(getComputerUseRuntimeStatus("/other-base")).resolves.toMatchObject({
      ready: true,
      lastError: null,
    });
    setCuaDriverStartupFailure("", null);
    await expect(getComputerUseRuntimeStatus("/base")).resolves.toMatchObject({
      ready: true,
      lastError: null,
    });
  });
  it.each(["managed", "system"] as const)(
    "accepts a compatible newer %s runtime",
    async (source) => {
      vi.mocked(resolveComputerUseRuntime).mockReturnValue({
        source,
        binaryPath: "/driver",
        policyPath: "/policy",
        version: null,
      });
      await expect(getComputerUseRuntimeStatus("/base")).resolves.toMatchObject({
        ready: true,
        state: "ready",
        repairRequired: false,
        version: "0.39.0",
        message: null,
      });
    },
  );

  it("rejects a newer runtime with an incompatible manifest even if a daemon is ready", async () => {
    vi.mocked(validateCuaDriverRuntime).mockRejectedValue(new Error("unsupported schema"));
    await expect(getComputerUseRuntimeStatus("/base")).resolves.toMatchObject({
      ready: false,
      state: "incompatible",
      repairRequired: true,
      message: "unsupported schema",
    });
  });

  it("requires live daemon validation, not only a compatible manifest", async () => {
    vi.mocked(getCuaDriverDaemonStatus).mockReturnValue({
      state: "degraded",
      binaryPath: "/driver",
      lastError: "missing required tools",
      healthSummary: null,
      repairRequired: true,
    });
    await expect(getComputerUseRuntimeStatus("/base")).resolves.toMatchObject({
      ready: false,
      repairRequired: true,
      lastError: "missing required tools",
    });
  });

  it("does not use readiness from a different runtime", async () => {
    vi.mocked(getCuaDriverDaemonStatus).mockReturnValue({
      state: "ready",
      binaryPath: "/other-driver",
      lastError: null,
      healthSummary: "ok",
      repairRequired: false,
    });
    await expect(getComputerUseRuntimeStatus("/base")).resolves.toMatchObject({ ready: false });
  });
});
