import { selectedComputerUseContractProfile } from "@bigbud/shared/computer-use/selection";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveComputerUseRuntimeEnv } from "./backendRuntimeEnv";

const mocks = vi.hoisted(() => ({
  startDaemon: vi.fn(async () => ({ BIGBUD_CUA_DRIVER_PATH: "/cua/bin/cua-driver" })),
}));

vi.mock("./cuaDriver.daemon", () => ({ startCuaDriverDaemon: mocks.startDaemon }));

describe("resolveComputerUseRuntimeEnv", () => {
  beforeEach(() => {
    mocks.startDaemon.mockClear();
  });

  it("selects the legacy profile for any pinned Driver", () => {
    expect(selectedComputerUseContractProfile).toBe("legacy");
  });

  it("starts the legacy daemon exactly as before under the pinned selection", async () => {
    const env = await resolveComputerUseRuntimeEnv("/base", "ai.bigbud.desktop");

    expect(mocks.startDaemon).toHaveBeenCalledTimes(1);
    expect(mocks.startDaemon).toHaveBeenCalledWith("/base", "ai.bigbud.desktop");
    expect(env).toEqual({ BIGBUD_CUA_DRIVER_PATH: "/cua/bin/cua-driver" });
  });

  it("never starts the legacy daemon when the supervised v2 profile is selected", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    const env = await resolveComputerUseRuntimeEnv("/base", "ai.bigbud.desktop", "v2");

    expect(mocks.startDaemon).not.toHaveBeenCalled();
    expect(env).toEqual({});
    info.mockRestore();
  });

  it("keeps continuing without the runtime when the legacy daemon fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.startDaemon.mockRejectedValueOnce(new Error("boom"));

    await expect(resolveComputerUseRuntimeEnv("/base", "ai.bigbud.desktop")).resolves.toEqual({});
    error.mockRestore();
  });
});
