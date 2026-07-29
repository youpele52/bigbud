import { describe, expect, it } from "vitest";

import {
  CUA_DRIVER_RELEASE_TAG,
  CUA_DRIVER_VERSION,
  cuaDriverReleaseUrl,
  resolveCuaDriverReleaseArtifact,
} from "./release";

describe("cua-driver release metadata", () => {
  it("pins the expected 0.9.1 artifacts", () => {
    expect(CUA_DRIVER_VERSION).toBe("0.9.1");
    expect(CUA_DRIVER_RELEASE_TAG).toBe("cua-driver-rs-v0.9.1");

    const darwinArm64 = resolveCuaDriverReleaseArtifact("darwin", "arm64");
    const darwinX64 = resolveCuaDriverReleaseArtifact("darwin", "x64");

    expect(darwinArm64).toMatchObject({
      archiveName: "cua-driver-rs-0.9.1-darwin-universal.tar.gz",
      binaryPath: ["cua-driver-rs-0.9.1-darwin-universal", "cua-driver"],
      appPath: ["cua-driver-rs-0.9.1-darwin-universal", "CuaDriver.app"],
    });
    expect(darwinX64).toBe(darwinArm64);

    expect(resolveCuaDriverReleaseArtifact("linux", "x64")).toMatchObject({
      archiveName: "cua-driver-rs-0.9.1-linux-x86_64-binary.tar.gz",
      sha256: "bec567cb6c93c486a5501fb0b67ba087d7938b17538d96d9f856768604a19fbc",
      binaryName: "cua-driver",
      binaryPath: ["cua-driver"],
      appPath: null,
    });
    expect(resolveCuaDriverReleaseArtifact("linux", "arm64")).toMatchObject({
      archiveName: "cua-driver-rs-0.9.1-linux-arm64-binary.tar.gz",
      sha256: "daa02eeb6789f953875c315e4c54d99ea6c51d4ba3228109db347fdbebe89dae",
      binaryName: "cua-driver",
      binaryPath: ["cua-driver"],
      appPath: null,
    });
    expect(resolveCuaDriverReleaseArtifact("win32", "x64")).toMatchObject({
      archiveName: "cua-driver-rs-0.9.1-windows-x86_64-binary.zip",
      sha256: "465224fb8b46ce32db6732c55a36aff9907cfae47a7a3a0173b45f95821df6e1",
      binaryName: "cua-driver.exe",
      binaryPath: ["cua-driver-rs-0.9.1-windows-x86_64", "cua-driver.exe"],
      appPath: null,
    });
    expect(resolveCuaDriverReleaseArtifact("win32", "arm64")).toMatchObject({
      archiveName: "cua-driver-rs-0.9.1-windows-arm64-binary.zip",
      sha256: "c64787437b4718f24613b99a3c124570f44f23abdc6fc856a868e8d6baed453f",
      binaryName: "cua-driver.exe",
      binaryPath: ["cua-driver-rs-0.9.1-windows-arm64", "cua-driver.exe"],
      appPath: null,
    });
  });

  it("builds the release URL from the selected artifact", () => {
    const artifact = resolveCuaDriverReleaseArtifact("darwin", "x64");
    expect(cuaDriverReleaseUrl(artifact)).toBe(
      "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.9.1/cua-driver-rs-0.9.1-darwin-universal.tar.gz",
    );
  });
});
