/** Absolute on Windows: a drive path (`C:\`, `C:/`) or a UNC path (`\\server\share`). */
export function isWindowsAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** Absolute on POSIX or Windows (drive or UNC). Relative, `~` and bare names never qualify. */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || isWindowsAbsolutePath(path);
}
