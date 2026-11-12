import type { ProcessRunResult } from "../../utils/processRunner";

export function inventory(
  rows: readonly (readonly [string, string])[] = [["/bin/zsh", "/bin/zsh"]],
  platform = "linux",
): string {
  return ["bigbud-shell-inventory-v1", platform, ...rows.flat(), "end-shell-inventory", ""].join(
    "\0",
  );
}

export function result(overrides: Partial<ProcessRunResult> = {}): ProcessRunResult {
  return {
    stdout: inventory(),
    stderr: "",
    code: 0,
    signal: null,
    timedOut: false,
    ...overrides,
  };
}
