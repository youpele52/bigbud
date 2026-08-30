import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";

function canonical(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function dangerousSystemRoots(home: string): readonly string[] {
  const platformRoots =
    process.platform === "win32"
      ? [
          process.env.SystemRoot,
          process.env.WINDIR,
          process.env.ProgramFiles,
          process.env["ProgramFiles(x86)"],
          process.env.ProgramData,
          path.dirname(home),
        ]
      : [
          "/bin",
          "/boot",
          "/dev",
          "/etc",
          "/home",
          "/lib",
          "/lib64",
          "/proc",
          "/root",
          "/run",
          "/sbin",
          "/sys",
          "/tmp",
          "/usr",
          "/var",
          "/Applications",
          "/Library",
          "/System",
          "/Users",
          "/Volumes",
          "/private/tmp",
          "/private/var",
        ];
  return [home, tmpdir(), ...platformRoots.filter((value): value is string => Boolean(value))];
}

/** Roots broad enough to represent a filesystem, system area, or user area are never authorized. */
export function isForbiddenDirectCleanupRoot(
  value: string,
  options: { readonly home?: string } = {},
): boolean {
  const resolved = canonical(value);
  const filesystemRoot = path.parse(resolved).root;
  const home = canonical(options.home ?? homedir());
  return (
    resolved === filesystemRoot ||
    dangerousSystemRoots(home).some((candidate) => canonical(candidate) === resolved)
  );
}

export function assertAllowedDirectCleanupRoot(value: string): void {
  if (isForbiddenDirectCleanupRoot(value)) {
    throw new Error("Resource cleanup root is forbidden by policy.");
  }
}
