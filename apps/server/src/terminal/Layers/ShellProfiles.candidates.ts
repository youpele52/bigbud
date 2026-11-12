/** Trusted compile-time policy shared by local and execution-host probes, never workspace PATH. */
export const UNIX_SHELL_ROOTS = Object.freeze([
  "/bin",
  "/usr/bin",
  "/usr/local/bin",
  "/opt/homebrew/bin",
] as const);
export const UNIX_SHELL_NAMES = Object.freeze(["zsh", "bash", "fish", "sh", "pwsh"] as const);

export function unixShellCandidates(): readonly string[] {
  return UNIX_SHELL_ROOTS.flatMap((root) => UNIX_SHELL_NAMES.map((name) => `${root}/${name}`));
}
