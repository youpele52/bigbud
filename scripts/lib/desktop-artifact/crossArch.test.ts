import { describe, expect, it } from "vitest";

import { SERVER_NATIVE_TARGET_ARCH_ENV } from "../native-release-build.ts";
import {
  isCrossArchBuild,
  optionalDependencyTargetFlags,
  serverBuildEnvironment,
  stagedDesktopBunInstallArgs,
  stagedServerNpmInstallArgs,
} from "./crossArch.ts";

const appleSilicon = { hostPlatform: "darwin", hostArch: "arm64" } as const;

describe("isCrossArchBuild", () => {
  it("detects macOS x64 on Apple Silicon only", () => {
    expect(isCrossArchBuild({ platform: "mac", arch: "x64", ...appleSilicon })).toBe(true);
    expect(isCrossArchBuild({ platform: "mac", arch: "arm64", ...appleSilicon })).toBe(false);
    expect(isCrossArchBuild({ platform: "mac", arch: "universal", ...appleSilicon })).toBe(false);
    // A different OS is not an architecture cross build.
    expect(isCrossArchBuild({ platform: "win", arch: "x64", ...appleSilicon })).toBe(false);
  });
});

describe("optionalDependencyTargetFlags", () => {
  it("selects the target OS and CPU on cross builds only", () => {
    expect(
      optionalDependencyTargetFlags({ platform: "mac", arch: "x64", ...appleSilicon }),
    ).toEqual(["--os=darwin", "--cpu=x64"]);
    expect(
      optionalDependencyTargetFlags({ platform: "mac", arch: "arm64", ...appleSilicon }),
    ).toEqual([]);
    expect(
      optionalDependencyTargetFlags({ platform: "mac", arch: "universal", ...appleSilicon }),
    ).toEqual([]);
  });
});

describe("stagedDesktopBunInstallArgs", () => {
  it("installs the x64 optional packages without host addon builds on a cross build", () => {
    expect(stagedDesktopBunInstallArgs({ platform: "mac", arch: "x64", ...appleSilicon })).toEqual([
      "install",
      "--production",
      "--os=darwin",
      "--cpu=x64",
      "--ignore-scripts",
    ]);
    expect(
      stagedDesktopBunInstallArgs({ platform: "mac", arch: "arm64", ...appleSilicon }),
    ).toEqual(["install", "--production"]);
  });
});

describe("stagedServerNpmInstallArgs", () => {
  it("keeps lifecycle scripts on native builds", () => {
    expect(stagedServerNpmInstallArgs({ platform: "mac", arch: "arm64", ...appleSilicon })).toEqual(
      ["install", "--omit=dev", "--install-links"],
    );
  });

  it("installs x64 optional packages without host lifecycle scripts on a cross build", () => {
    expect(stagedServerNpmInstallArgs({ platform: "mac", arch: "x64", ...appleSilicon })).toEqual([
      "install",
      "--omit=dev",
      "--install-links",
      "--os=darwin",
      "--cpu=x64",
      "--ignore-scripts",
    ]);
  });
});

describe("serverBuildEnvironment", () => {
  it("names the target architecture for same-OS builds and drops a stale value", () => {
    const base = { PATH: "/bin", [SERVER_NATIVE_TARGET_ARCH_ENV]: "arm64" };
    expect(serverBuildEnvironment({ platform: "mac", arch: "x64", ...appleSilicon }, base)).toEqual(
      { PATH: "/bin", [SERVER_NATIVE_TARGET_ARCH_ENV]: "x64" },
    );
    expect(
      serverBuildEnvironment({ platform: "mac", arch: "arm64", ...appleSilicon }, base),
    ).toEqual({ PATH: "/bin", [SERVER_NATIVE_TARGET_ARCH_ENV]: "arm64" });
  });

  it("leaves the server build on the host for universal and cross-OS builds", () => {
    const base = { PATH: "/bin", [SERVER_NATIVE_TARGET_ARCH_ENV]: "x64" };
    expect(
      serverBuildEnvironment({ platform: "mac", arch: "universal", ...appleSilicon }, base),
    ).toEqual({ PATH: "/bin" });
    expect(serverBuildEnvironment({ platform: "win", arch: "x64", ...appleSilicon }, base)).toEqual(
      { PATH: "/bin" },
    );
  });
});
