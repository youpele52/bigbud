import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./cuaDriver.mcpClient", () => ({
  callCuaDriverTool: vi.fn(),
}));

import { callCuaDriverTool } from "./cuaDriver.mcpClient";
import {
  checkComputerUsePermissions,
  missingComputerUsePermissionsStatus,
  pendingHostAccessibilityPermissionsStatus,
} from "./cuaDriver.permissions";

const mockedCallCuaDriverTool = vi.mocked(callCuaDriverTool);

describe("checkComputerUsePermissions", () => {
  beforeEach(() => {
    mockedCallCuaDriverTool.mockReset();
  });

  it("parses granted macOS-style permissions from the cua-driver response", async () => {
    mockedCallCuaDriverTool.mockResolvedValue({
      content: [{ type: "text", text: "All permissions granted." }],
      structuredContent: {
        accessibility: true,
        screen_recording: true,
        screen_recording_capturable: true,
        source: {
          attribution: "host",
          embedded: true,
          host_bundle_id: "ai.bigbud.desktop.dev",
        },
      },
    });

    await expect(
      checkComputerUsePermissions({
        binaryPath: "/tmp/cua-driver",
      }),
    ).resolves.toEqual({
      runtimeAvailable: true,
      granted: true,
      message: "All permissions granted.",
      permissions: [
        { name: "accessibility", granted: true },
        { name: "screen_recording", granted: true },
        { name: "screen_recording_capturable", granted: true },
      ],
      source: {
        attribution: "host",
        embedded: true,
        hostBundleId: "ai.bigbud.desktop.dev",
      },
    });

    expect(mockedCallCuaDriverTool).toHaveBeenCalledWith(
      "/tmp/cua-driver",
      "check_permissions",
      { prompt: false },
      {},
    );
  });

  it("checks permissions without asking macOS to show another prompt", async () => {
    mockedCallCuaDriverTool.mockResolvedValue({
      structuredContent: {
        permissions: [{ name: "accessibility", granted: false }],
      },
    });

    await checkComputerUsePermissions({
      binaryPath: "/tmp/cua-driver",
    });

    expect(mockedCallCuaDriverTool).toHaveBeenCalledWith(
      "/tmp/cua-driver",
      "check_permissions",
      { prompt: false },
      {},
    );
  });

  it("coalesces concurrent checks and allows a later retry", async () => {
    let resolveFirstCall: (value: unknown) => void;
    mockedCallCuaDriverTool.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstCall = resolve;
        }),
    );

    const first = checkComputerUsePermissions({ binaryPath: "/tmp/cua-driver" });
    const second = checkComputerUsePermissions({ binaryPath: "/tmp/cua-driver" });

    expect(mockedCallCuaDriverTool).toHaveBeenCalledTimes(1);
    resolveFirstCall!({
      structuredContent: {
        permissions: [{ name: "accessibility", granted: true }],
      },
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        runtimeAvailable: true,
        granted: true,
        message: null,
        permissions: [{ name: "accessibility", granted: true }],
      },
      {
        runtimeAvailable: true,
        granted: true,
        message: null,
        permissions: [{ name: "accessibility", granted: true }],
      },
    ]);

    mockedCallCuaDriverTool.mockResolvedValueOnce({ structuredContent: { permissions: [] } });
    await checkComputerUsePermissions({ binaryPath: "/tmp/cua-driver" });
    expect(mockedCallCuaDriverTool).toHaveBeenCalledTimes(2);
  });

  it("does not coalesce checks across daemon generations", async () => {
    mockedCallCuaDriverTool.mockResolvedValue({
      structuredContent: { permissions: [{ name: "accessibility", granted: true }] },
    });

    await Promise.all([
      checkComputerUsePermissions({
        binaryPath: "/tmp/cua-driver",
        environment: {
          BIGBUD_CUA_ENDPOINT: "/tmp/cua.sock",
          BIGBUD_CUA_RUNTIME_GENERATION: "1",
        },
      }),
      checkComputerUsePermissions({
        binaryPath: "/tmp/cua-driver",
        environment: {
          BIGBUD_CUA_ENDPOINT: "/tmp/cua.sock",
          BIGBUD_CUA_RUNTIME_GENERATION: "2",
        },
      }),
    ]);

    expect(mockedCallCuaDriverTool).toHaveBeenCalledTimes(2);
  });

  it("reports partial grants as not fully granted", async () => {
    mockedCallCuaDriverTool.mockResolvedValue({
      structuredContent: {
        permissions: [
          { name: "accessibility", granted: true },
          { name: "screen_recording", granted: false },
        ],
      },
    });

    await expect(
      checkComputerUsePermissions({
        binaryPath: "/tmp/cua-driver",
      }),
    ).resolves.toMatchObject({
      runtimeAvailable: true,
      granted: false,
      permissions: [
        { name: "accessibility", granted: true },
        { name: "screen_recording", granted: false },
      ],
    });
  });

  it("returns a failure status when the driver call throws", async () => {
    mockedCallCuaDriverTool.mockRejectedValue(new Error("driver unavailable"));

    await expect(
      checkComputerUsePermissions({
        binaryPath: "/tmp/cua-driver",
      }),
    ).resolves.toEqual({
      runtimeAvailable: true,
      granted: false,
      message: "driver unavailable",
      permissions: [],
    });
  });
});

describe("pendingHostAccessibilityPermissionsStatus", () => {
  it("returns actionable host-owned permission guidance", () => {
    expect(pendingHostAccessibilityPermissionsStatus("ai.bigbud.desktop.dev")).toEqual({
      runtimeAvailable: true,
      granted: false,
      pendingHostAccessibilityApproval: true,
      message:
        "Enable Accessibility for the current bigbud desktop app in System Settings, then return and check access again.",
      permissions: [{ name: "accessibility", granted: false }],
      source: {
        attribution: "host",
        embedded: true,
        hostBundleId: "ai.bigbud.desktop.dev",
      },
    });
  });
});

describe("missingComputerUsePermissionsStatus", () => {
  it("marks runtime as unavailable when the driver is missing", () => {
    expect(missingComputerUsePermissionsStatus("Install runtime first.")).toEqual({
      runtimeAvailable: false,
      granted: false,
      message: "Install runtime first.",
      permissions: [],
    });
  });
});
