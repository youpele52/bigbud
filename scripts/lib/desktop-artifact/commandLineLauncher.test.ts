import { expect, it } from "vitest";
import { commandLineLauncherBuildPlan } from "./commandLineLauncher.ts";

it("builds the Windows shim for the artifact architecture, not the build host", () => {
  const plan = commandLineLauncherBuildPlan({
    repoRoot: "/repo",
    arch: "x64",
    hostPlatform: "darwin",
    hostArch: "arm64",
  });
  expect(plan.cargoArgs).toEqual([
    "build",
    "--locked",
    "--release",
    "--package",
    "bigbud-cli-launcher",
    "--target",
    "x86_64-pc-windows-msvc",
  ]);
  expect(plan.source).toBe("/repo/target/x86_64-pc-windows-msvc/release/bigbud-cli-launcher.exe");
  const native = commandLineLauncherBuildPlan({
    repoRoot: "/repo",
    arch: "arm64",
    hostPlatform: "win32",
    hostArch: "arm64",
  });
  expect(native.cargoArgs).not.toContain("--target");
  expect(native.source).toBe("/repo/target/release/bigbud-cli-launcher.exe");
});
