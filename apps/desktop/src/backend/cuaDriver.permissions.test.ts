import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./cuaDriver.mcpClient", () => ({
  callCuaDriverTool: vi.fn(),
}));

import { callCuaDriverTool } from "./cuaDriver.mcpClient";
import {
  checkComputerUsePermissions,
  missingComputerUsePermissionsStatus,
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
        permissions: [
          { name: "accessibility", granted: true },
          { name: "screen_recording", granted: true },
        ],
      },
    });

    await expect(
      checkComputerUsePermissions({
        binaryPath: "/tmp/cua-driver",
        prompt: false,
      }),
    ).resolves.toEqual({
      runtimeAvailable: true,
      granted: true,
      message: "All permissions granted.",
      permissions: [
        { name: "accessibility", granted: true },
        { name: "screen_recording", granted: true },
      ],
    });

    expect(mockedCallCuaDriverTool).toHaveBeenCalledWith(
      "/tmp/cua-driver",
      "check_permissions",
      {},
    );
  });

  it("requests prompts when prompt=true", async () => {
    mockedCallCuaDriverTool.mockResolvedValue({
      structuredContent: {
        permissions: [{ name: "accessibility", granted: false }],
      },
    });

    await checkComputerUsePermissions({
      binaryPath: "/tmp/cua-driver",
      prompt: true,
    });

    expect(mockedCallCuaDriverTool).toHaveBeenCalledWith("/tmp/cua-driver", "check_permissions", {
      prompt: true,
    });
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
        prompt: false,
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
        prompt: false,
      }),
    ).resolves.toEqual({
      runtimeAvailable: true,
      granted: false,
      message: "driver unavailable",
      permissions: [],
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
