import * as Path from "node:path";

export function binaryName(): string {
  return process.platform === "win32" ? "cua-driver.exe" : "cua-driver";
}

export function resolveManagedPaths(baseDir: string) {
  const rootDir = Path.join(baseDir, "runtime", "cua-driver");
  const binDir = Path.join(rootDir, "bin");
  const homeDir = Path.join(rootDir, "home");
  const downloadDir = Path.join(rootDir, "download");
  return {
    rootDir,
    binDir,
    homeDir,
    downloadDir,
    binaryPath: Path.join(binDir, binaryName()),
  };
}
