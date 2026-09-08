import { describe, expect, it } from "vitest";

import {
  desktopSupervisorBinaryName,
  desktopSupervisorBuildPlan,
  packagedDesktopSupervisorPath,
} from "./desktopSupervisor.ts";

describe("desktop delivery supervisor staging", () => {
  it("uses platform-native binary names and an isolated resource directory", () => {
    expect(desktopSupervisorBinaryName("mac")).toBe("bigbud-desktop-supervisor");
    expect(desktopSupervisorBinaryName("linux")).toBe("bigbud-desktop-supervisor");
    expect(desktopSupervisorBinaryName("win")).toBe("bigbud-desktop-supervisor.exe");
    expect(packagedDesktopSupervisorPath("/stage/apps/server", "linux")).toBe(
      "/stage/apps/server/delivery-supervisor/bin/bigbud-desktop-supervisor",
    );
  });

  it("uses a target-specific locked release build", () => {
    const plan = desktopSupervisorBuildPlan({
      repoRoot: "/repo",
      platform: "mac",
      arch: "x64",
      hostPlatform: "darwin",
      hostArch: "arm64",
    });
    expect(plan.cargoArgs).toEqual([
      "build",
      "--locked",
      "--release",
      "--package",
      "bigbud-desktop-supervisor",
      "--target",
      "x86_64-apple-darwin",
    ]);
    expect(plan.source).toBe("/repo/target/x86_64-apple-darwin/release/bigbud-desktop-supervisor");
  });
});
