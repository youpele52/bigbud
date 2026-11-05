let failure: { key: string; message: string } | null = null;

/** Keep preflight diagnostics scoped to the selected installation, not a prior runtime. */
export function cuaDriverRuntimeKey(
  baseDir: string,
  binaryPath: string,
  policyPath: string | null,
): string {
  return `${baseDir}\0${binaryPath}\0${policyPath ?? ""}`;
}

export function setCuaDriverStartupFailure(key: string, message: string | null): void {
  failure = message === null ? null : { key, message };
}

export function getCuaDriverStartupFailure(key: string): string | null {
  return failure?.key === key ? failure.message : null;
}
