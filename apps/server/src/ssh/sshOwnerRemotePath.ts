import path from "node:path";

/**
 * The single trust rule for an owner-selected remote executable path: an
 * absolute, already-normalized POSIX path with no surrounding whitespace and no
 * NUL byte. Any other value keeps the provider refused rather than admitting a
 * caller-shaped program.
 *
 * @module sshOwnerRemotePath
 */
export function isTrustedRemoteExecutablePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !value.includes("\0") &&
    value.trim() === value &&
    path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value
  );
}
