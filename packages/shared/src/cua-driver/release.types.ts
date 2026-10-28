export type CuaDriverRuntimePlatform = "darwin" | "linux" | "win32";
export type CuaDriverRuntimeArch = "arm64" | "x64";

export interface CuaDriverReleaseArtifact {
  readonly archiveName: string;
  readonly sha256: string;
  readonly binaryName: string;
  readonly binaryPath: ReadonlyArray<string>;
  readonly appPath: ReadonlyArray<string> | null;
}

/** `null` = no verified artifact for that target; installation refuses it. */
export type CuaDriverReleaseTable = Readonly<
  Record<
    CuaDriverRuntimePlatform,
    Readonly<Record<CuaDriverRuntimeArch, CuaDriverReleaseArtifact | null>>
  >
>;
