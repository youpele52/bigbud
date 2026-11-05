import { describe, expect, it } from "vitest";

import {
  CUA_DRIVER_RELEASE_TAG,
  CUA_DRIVER_VERSION,
  cuaDriverReleaseUrl,
  resolveCuaDriverReleaseArtifact,
  resolveCuaDriverReleaseArtifactFor,
} from "./release";
import {
  CUA_DRIVER_0_38_0_ARTIFACTS,
  CUA_DRIVER_0_38_0_DARWIN_ARM64_EVIDENCE,
} from "./release.v0_38_0";

describe("cua-driver release metadata", () => {
  it("pins 0.38.0 and keeps the retained 0.9.1 artifacts for rollback", () => {
    expect(CUA_DRIVER_VERSION).toBe("0.38.0");
    expect(CUA_DRIVER_RELEASE_TAG).toBe("cua-driver-rs-v0.38.0");

    const darwinArm64 = resolveCuaDriverReleaseArtifactFor("0.9.1", "darwin", "arm64");
    const darwinX64 = resolveCuaDriverReleaseArtifactFor("0.9.1", "darwin", "x64");

    expect(darwinArm64).toMatchObject({
      archiveName: "cua-driver-rs-0.9.1-darwin-universal.tar.gz",
      binaryPath: ["cua-driver-rs-0.9.1-darwin-universal", "cua-driver"],
      appPath: ["cua-driver-rs-0.9.1-darwin-universal", "CuaDriver.app"],
    });
    expect(darwinX64).toBe(darwinArm64);

    expect(resolveCuaDriverReleaseArtifactFor("0.9.1", "linux", "x64")).toMatchObject({
      archiveName: "cua-driver-rs-0.9.1-linux-x86_64-binary.tar.gz",
      sha256: "bec567cb6c93c486a5501fb0b67ba087d7938b17538d96d9f856768604a19fbc",
      binaryName: "cua-driver",
      binaryPath: ["cua-driver"],
      appPath: null,
    });
    expect(resolveCuaDriverReleaseArtifactFor("0.9.1", "linux", "arm64")).toMatchObject({
      archiveName: "cua-driver-rs-0.9.1-linux-arm64-binary.tar.gz",
      sha256: "daa02eeb6789f953875c315e4c54d99ea6c51d4ba3228109db347fdbebe89dae",
      binaryName: "cua-driver",
      binaryPath: ["cua-driver"],
      appPath: null,
    });
    expect(resolveCuaDriverReleaseArtifactFor("0.9.1", "win32", "x64")).toMatchObject({
      archiveName: "cua-driver-rs-0.9.1-windows-x86_64-binary.zip",
      sha256: "465224fb8b46ce32db6732c55a36aff9907cfae47a7a3a0173b45f95821df6e1",
      binaryName: "cua-driver.exe",
      binaryPath: ["cua-driver.exe"],
      appPath: null,
    });
    expect(resolveCuaDriverReleaseArtifactFor("0.9.1", "win32", "arm64")).toMatchObject({
      archiveName: "cua-driver-rs-0.9.1-windows-arm64-binary.zip",
      sha256: "c64787437b4718f24613b99a3c124570f44f23abdc6fc856a868e8d6baed453f",
      binaryName: "cua-driver.exe",
      binaryPath: ["cua-driver.exe"],
      appPath: null,
    });
  });

  it("builds the release URL from the selected artifact", () => {
    const artifact = resolveCuaDriverReleaseArtifact("darwin", "x64");
    expect(cuaDriverReleaseUrl(artifact)).toBe(
      "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.38.0/cua-driver-rs-0.38.0-darwin-universal-binary.tar.gz",
    );
  });

  it("resolves every 0.38.0 target to its verified plain-binary archive", () => {
    const mac = {
      archiveName: "cua-driver-rs-0.38.0-darwin-universal-binary.tar.gz",
      sha256: "2bb8dc4a7e69185ffd04c4a9c0eab590bd2c54b72c2c1be13ab675be4f487732",
      binaryName: "cua-driver",
      binaryPath: ["cua-driver"],
      appPath: null,
    };
    const expected = {
      darwin: { arm64: mac, x64: mac },
      linux: {
        arm64: {
          archiveName: "cua-driver-rs-0.38.0-linux-arm64-binary.tar.gz",
          sha256: "80c9ae66bc7322052dd426c6133c96086b33894bf06c972bca8215384400b33d",
          binaryName: "cua-driver",
          binaryPath: ["cua-driver"],
          appPath: null,
        },
        x64: {
          archiveName: "cua-driver-rs-0.38.0-linux-x86_64-binary.tar.gz",
          sha256: "31ab9709dd91ce73677e49b9f3e75c6f0d3e4d9625c286c9e58262bfbea698dd",
          binaryName: "cua-driver",
          binaryPath: ["cua-driver"],
          appPath: null,
        },
      },
      win32: {
        arm64: {
          archiveName: "cua-driver-rs-0.38.0-windows-arm64-binary.zip",
          sha256: "d25c8ebfffb34e4c095ea170baf47b87c35dc0d1116f42e46b39df2bcbff8700",
          binaryName: "cua-driver.exe",
          binaryPath: ["cua-driver.exe"],
          appPath: null,
        },
        x64: {
          archiveName: "cua-driver-rs-0.38.0-windows-x86_64-binary.zip",
          sha256: "5edaa74d0afa1b55a9668dbc4f32736507bd2bd4d75b18ca1dc8881bb12402b5",
          binaryName: "cua-driver.exe",
          binaryPath: ["cua-driver.exe"],
          appPath: null,
        },
      },
    } as const;
    for (const platform of ["darwin", "linux", "win32"] as const) {
      for (const arch of ["arm64", "x64"] as const) {
        expect(CUA_DRIVER_0_38_0_ARTIFACTS[platform][arch]).toEqual(expected[platform][arch]);
        expect(resolveCuaDriverReleaseArtifactFor("0.38.0", platform, arch)).toEqual(
          expected[platform][arch],
        );
      }
    }
    expect(
      cuaDriverReleaseUrl(
        resolveCuaDriverReleaseArtifactFor("0.38.0", "darwin", "arm64"),
        "0.38.0",
      ),
    ).toBe(
      "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.38.0/cua-driver-rs-0.38.0-darwin-universal-binary.tar.gz",
    );
    // Probe A evidence is retained, never reused as another target's hash.
    expect(CUA_DRIVER_0_38_0_DARWIN_ARM64_EVIDENCE.archiveSha256).toBe(
      "5f71191c082ca07c9dfc13b7c9a6eec60a82818c245a93534cc0eb7911471d72",
    );
  });
});
