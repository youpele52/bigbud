import { describe, expect, it } from "vitest";
import type {
  DesktopComputerUsePermissionsStatus,
  DesktopComputerUseRuntimeStatus,
} from "@bigbud/contracts";
import {
  getComputerUseStartupPermissionsNotice,
  getComputerUseStartupRuntimeNotice,
} from "./ComputerUseStartupRepair.logic";

const readyRuntime: DesktopComputerUseRuntimeStatus = {
  available: true,
  ready: true,
  repairRequired: false,
  state: "ready",
  source: "managed",
  binaryPath: "/tmp/cua-driver",
  version: "cua-driver 0.9.1",
  expectedVersion: "0.9.1",
  manifestSchema: "1",
  policyVersion: "1",
  policySha256: "digest",
  daemonState: "ready",
  platform: "darwin",
  architecture: "arm64",
  platformHealth: "ready",
  healthSummary: "ok",
  lastError: null,
  message: null,
  diagnostics: null,
};

const grantedPermissions: DesktopComputerUsePermissionsStatus = {
  runtimeAvailable: true,
  granted: true,
  message: null,
  permissions: [{ name: "accessibility", granted: true }],
};

describe("Computer Use startup repair notices", () => {
  it("asks for runtime repair before checking permissions when the runtime is not ready", () => {
    expect(
      getComputerUseStartupRuntimeNotice({
        ...readyRuntime,
        ready: false,
        repairRequired: true,
        state: "incompatible",
        message: "Expected cua-driver 0.9.1.",
      }),
    ).toEqual({
      type: "error",
      title: "Computer Use needs repair",
      description: "Expected cua-driver 0.9.1.",
    });
  });

  it("does not call permission degradation a runtime repair problem", () => {
    expect(
      getComputerUseStartupRuntimeNotice({
        ...readyRuntime,
        ready: false,
        repairRequired: false,
        state: "degraded",
        daemonState: "degraded",
        platformHealth: "degraded",
        healthSummary: "degraded",
      }),
    ).toBeNull();
  });

  it("does not notify when the runtime is ready and permissions are granted", () => {
    expect(getComputerUseStartupRuntimeNotice(readyRuntime)).toBeNull();
    expect(getComputerUseStartupPermissionsNotice(grantedPermissions)).toBeNull();
  });

  it("prompts for Settings repair when a required desktop permission is missing", () => {
    expect(
      getComputerUseStartupPermissionsNotice({
        ...grantedPermissions,
        granted: false,
        message: "Accessibility is not granted.",
        permissions: [{ name: "accessibility", granted: false }],
      }),
    ).toEqual({
      type: "warning",
      title: "Desktop permissions needed",
      description: "Accessibility is not granted.",
    });
  });

  it("reports a failed permission check as a runtime repair problem", () => {
    expect(
      getComputerUseStartupPermissionsNotice({
        runtimeAvailable: true,
        granted: false,
        message: "Permission check failed.",
        permissions: [],
      }),
    ).toEqual({
      type: "error",
      title: "Computer Use needs repair",
      description: "Permission check failed.",
    });
  });
});
