import { describe, expect, it, vi } from "vitest";

// Simulate the 0.38.0 pin without flipping it (lean upgrade M1): before the
// decoupling, this pin selected the dormant v2 profile and stopped the daemon.
vi.mock("../cua-driver/release.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cua-driver/release.ts")>()),
  CUA_DRIVER_VERSION: "0.38.0",
}));

const { CUA_DRIVER_VERSION } = await import("../cua-driver/release.ts");
const {
  COMPUTER_USE_SUPERVISED_DEV_ENV,
  resolveSupervisedExecutionGate,
  selectedComputerUseContractProfile,
} = await import("./selection.ts");

describe("contract profile under a 0.38.0 pin", () => {
  it("stays legacy and keeps the supervised gate closed", () => {
    expect(CUA_DRIVER_VERSION).toBe("0.38.0");
    expect(selectedComputerUseContractProfile).toBe("legacy");
    expect(
      resolveSupervisedExecutionGate({
        profile: selectedComputerUseContractProfile,
        platform: "darwin",
        arch: "arm64",
        development: true,
        env: { [COMPUTER_USE_SUPERVISED_DEV_ENV]: "1" },
      }),
    ).toEqual({ open: false, reason: "legacy-profile" });
  });
});
