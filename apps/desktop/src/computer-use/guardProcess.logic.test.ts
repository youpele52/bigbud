import { describe, expect, it } from "vitest";

import { COMPUTER_USE_SUPERVISED_DEV_ENV } from "@bigbud/shared/computer-use/selection";

import { guardExitReason, resolveGuardLaunchPlan } from "./guardProcess.logic";

const dev = {
  isDevelopment: true,
  isPackaged: false,
  platform: "darwin" as const,
  arch: "arm64",
  env: { [COMPUTER_USE_SUPERVISED_DEV_ENV]: "1" },
  rootDir: "/repo",
  developmentRoot: "/Users/u/.bigbud/dev/computer-use",
};

describe("resolveGuardLaunchPlan", () => {
  it("never starts while the legacy profile is selected", () => {
    expect(resolveGuardLaunchPlan(dev)).toEqual({ start: false, reason: "legacy-profile" });
  });

  it("starts the debug guard on the isolated development root after the switch", () => {
    expect(resolveGuardLaunchPlan({ ...dev, profile: "v2" })).toEqual({
      start: true,
      binaryPath: "/repo/target/debug/bigbud-computer-use",
      args: ["guard", "--development-root", "/Users/u/.bigbud/dev/computer-use"],
    });
  });

  it("needs the explicit development opt-in and never runs packaged", () => {
    expect(resolveGuardLaunchPlan({ ...dev, profile: "v2", env: {} })).toEqual({
      start: false,
      reason: "tuple-unqualified",
    });
    expect(
      resolveGuardLaunchPlan({ ...dev, profile: "v2", isPackaged: true, developmentRoot: null }),
    ).toEqual({ start: false, reason: "tuple-unqualified" });
    expect(resolveGuardLaunchPlan({ ...dev, profile: "v2", platform: "linux" })).toEqual({
      start: false,
      reason: "packaged",
    });
  });
});

describe("guardExitReason", () => {
  it("mirrors the native exit statuses", () => {
    expect(guardExitReason(0, null)).toBe("settled");
    expect(guardExitReason(3, null)).toBe("storage");
    expect(guardExitReason(4, null)).toBe("conflict");
    expect(guardExitReason(6, null)).toBe("unsettled");
    expect(guardExitReason(1, null)).toBe("unknown");
    expect(guardExitReason(null, "SIGKILL")).toBe("killed");
  });
});
