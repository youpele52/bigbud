/**
 * The single trust rule for an owner-selected remote executable path, shared by
 * the server (owner launch) and the web settings form: an absolute, already
 * normalized POSIX path with no surrounding whitespace and no NUL byte.
 *
 * Runtime-neutral (no `node:path`), so the browser applies exactly the rule the
 * server enforces. It matches `path.posix.normalize(value) === value` for
 * absolute paths: no empty, `.` or `..` segments; one trailing slash is kept.
 *
 * @module remoteExecutablePath
 */
export function isTrustedRemoteExecutablePath(value: unknown): value is string {
  if (typeof value !== "string" || value.includes("\0") || value.trim() !== value) return false;
  if (!value.startsWith("/")) return false;
  const segments = value.slice(1).split("/");
  return segments.every((segment, index) => {
    if (segment === "." || segment === "..") return false;
    // Only the final segment may be empty: "/" itself or one trailing slash.
    return segment !== "" || index === segments.length - 1;
  });
}
