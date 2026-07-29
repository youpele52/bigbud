export const CUA_DRIVER_VERSION = "0.9.1";
export const CUA_DRIVER_REPOSITORY = "trycua/cua";
export const CUA_DRIVER_RELEASE_TAG = `cua-driver-rs-v${CUA_DRIVER_VERSION}`;

export type CuaDriverRuntimePlatform = "darwin" | "linux" | "win32";
export type CuaDriverRuntimeArch = "arm64" | "x64";

export interface CuaDriverReleaseArtifact {
  readonly archiveName: string;
  readonly sha256: string;
  readonly binaryName: string;
  readonly binaryPath: ReadonlyArray<string>;
  readonly appPath: ReadonlyArray<string> | null;
}

const macArtifact: CuaDriverReleaseArtifact = {
  archiveName: "cua-driver-rs-0.9.1-darwin-universal.tar.gz",
  sha256: "5dad46515b14dab9d97bd8365a02f42edc09fb7a5b431254af9fef0a1306bfac",
  binaryName: "cua-driver",
  binaryPath: ["cua-driver-rs-0.9.1-darwin-universal", "cua-driver"],
  appPath: ["cua-driver-rs-0.9.1-darwin-universal", "CuaDriver.app"],
};

const artifacts: Record<
  CuaDriverRuntimePlatform,
  Record<CuaDriverRuntimeArch, CuaDriverReleaseArtifact>
> = {
  darwin: { arm64: macArtifact, x64: macArtifact },
  linux: {
    arm64: {
      archiveName: "cua-driver-rs-0.9.1-linux-arm64-binary.tar.gz",
      sha256: "daa02eeb6789f953875c315e4c54d99ea6c51d4ba3228109db347fdbebe89dae",
      binaryName: "cua-driver",
      binaryPath: ["cua-driver"],
      appPath: null,
    },
    x64: {
      archiveName: "cua-driver-rs-0.9.1-linux-x86_64-binary.tar.gz",
      sha256: "bec567cb6c93c486a5501fb0b67ba087d7938b17538d96d9f856768604a19fbc",
      binaryName: "cua-driver",
      binaryPath: ["cua-driver"],
      appPath: null,
    },
  },
  win32: {
    arm64: {
      archiveName: "cua-driver-rs-0.9.1-windows-arm64-binary.zip",
      sha256: "c64787437b4718f24613b99a3c124570f44f23abdc6fc856a868e8d6baed453f",
      binaryName: "cua-driver.exe",
      binaryPath: ["cua-driver.exe"],
      appPath: null,
    },
    x64: {
      archiveName: "cua-driver-rs-0.9.1-windows-x86_64-binary.zip",
      sha256: "465224fb8b46ce32db6732c55a36aff9907cfae47a7a3a0173b45f95821df6e1",
      binaryName: "cua-driver.exe",
      binaryPath: ["cua-driver.exe"],
      appPath: null,
    },
  },
};

export function resolveCuaDriverReleaseArtifact(
  platform: CuaDriverRuntimePlatform,
  arch: CuaDriverRuntimeArch,
): CuaDriverReleaseArtifact {
  return artifacts[platform][arch];
}

export function cuaDriverReleaseUrl(artifact: CuaDriverReleaseArtifact): string {
  return `https://github.com/${CUA_DRIVER_REPOSITORY}/releases/download/${CUA_DRIVER_RELEASE_TAG}/${artifact.archiveName}`;
}
