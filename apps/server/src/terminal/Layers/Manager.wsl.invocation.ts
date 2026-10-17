import type { TerminalWslIdentity } from "@bigbud/contracts/workspace/terminal.wsl.ts";
import type { ShellCandidate } from "./Manager.shell";
import { wslExecutable } from "./Manager.wsl.process";

export const WSL_IDENTITY_SCRIPT = [
  "u=$(id -un) && i=$(id -u) || exit 79",
  'case "$HOME" in /*) ;; *) exit 79;; esac',
  'printf "identity\\000%s\\000%s\\000%s\\000" "$u" "$i" "$HOME"',
].join("; ");

const IDENTITY_CHECK = 'test "$(id -un)" = "$1" && test "$(id -u)" = "$2" || exit 79; shift 2';
export const WSL_CWD_FAILURE_OUTPUT = "cwd-error\0";

export const WSL_PATH_SCRIPT = [
  IDENTITY_CHECK,
  'p="$1"',
  'if [ "$2" = windows ]; then p=$(wslpath -a -u "$p") || exit 80; fi',
  'case "$p" in "~") p="$HOME";; "~/"*) p="$HOME/${p#\\~/}";; esac',
  'case "$p" in /*) ;; *) exit 80;; esac',
  'if [ "$3" = directory ]; then [ -d "$p" ] && [ -x "$p" ] && cd "$p" 2>/dev/null || { printf "cwd-error\\000"; exit 77; }; p=$(pwd -P) || exit 80; fi',
  'printf "path\\000%s\\000" "$p"',
].join("; ");

export function wslEnvironmentArgs(env: Readonly<Record<string, string>> = {}): string[] {
  return Object.entries(env).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value.includes("\0"))
      throw new Error("Invalid WSL terminal environment override.");
    return `${name}=${value}`;
  });
}

/** Dynamic data is argv, not shell source; the distro is always explicit. */
export function wslProbeArgs(input: {
  distribution: string;
  identity?: TerminalWslIdentity;
  script: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
}): string[] {
  return [
    "--distribution",
    input.distribution,
    ...(input.identity ? ["--user", input.identity.username] : []),
    "--exec",
    "/usr/bin/env",
    ...wslEnvironmentArgs(input.env),
    "/bin/sh",
    "-c",
    input.script,
    "sh",
    ...(input.args ?? []),
  ];
}

/** Validate pinned identity and cwd again at the final PTY boundary. */
export function buildWslTerminalShellCandidate(input: {
  wslIdentity?: TerminalWslIdentity | undefined;
  cwd: string;
  runtimeEnv: Readonly<Record<string, string>> | null;
}): ShellCandidate {
  const identity = input.wslIdentity;
  if (!identity) throw new Error("The WSL terminal identity has not been resolved.");
  return {
    shell: wslExecutable(),
    label: `WSL (${identity.distribution}, ${identity.username})`,
    dropPathMode: "posix",
    args: wslProbeArgs({
      distribution: identity.distribution,
      identity,
      env: input.runtimeEnv ?? {},
      script: `${IDENTITY_CHECK}; cd "$1" 2>/dev/null || exit 77; exec "\${SHELL:-/bin/sh}" -l`,
      args: [identity.username, String(identity.uid), input.cwd],
    }),
  };
}
