/** Normal Win32 paths can alias names ending in ASCII spaces or dots. */
export function hasWindowsPathAlias(path: string): boolean {
  return path
    .split(/[\\/]/)
    .some((segment) => segment !== "." && segment !== ".." && /[ .]$/.test(segment));
}
