import { describe, expect, it } from "vitest";

import { COMPUTER_USE_SUPERVISED_DEV_ENV } from "@bigbud/shared/computer-use/selection";

import { devModeRequiresComputerUseGuard } from "./dev-runner.computerUse.ts";

const optIn = { [COMPUTER_USE_SUPERVISED_DEV_ENV]: "1" };

describe("devModeRequiresComputerUseGuard", () => {
  it("never builds the guard while the legacy profile is pinned", () => {
    expect(devModeRequiresComputerUseGuard("dev:desktop", optIn, "darwin", "arm64")).toBe(false);
  });

  it("builds only for dev:desktop on macOS with the explicit opt-in after the switch", () => {
    expect(devModeRequiresComputerUseGuard("dev:desktop", optIn, "darwin", "arm64", "v2")).toBe(
      true,
    );
    expect(devModeRequiresComputerUseGuard("dev:desktop", {}, "darwin", "arm64", "v2")).toBe(false);
    expect(devModeRequiresComputerUseGuard("dev", optIn, "darwin", "arm64", "v2")).toBe(false);
    expect(devModeRequiresComputerUseGuard("dev:desktop", optIn, "linux", "x64", "v2")).toBe(false);
  });
});
