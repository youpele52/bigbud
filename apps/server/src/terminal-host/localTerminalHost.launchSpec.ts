/**
 * Local launch parity (plan §15 S6, §12). A terminal in the local Rust host must start exactly
 * like the in-process node-pty terminal it replaces: the real platform, the server's full spawn
 * environment (login-shell environment, requested `PATH`, lowercase names such as `http_proxy`,
 * and the pane shell-integration variables), and `local_launch`, so the host honours that
 * environment instead of the remote allowlist.
 *
 * Pane shell integration is environment-only (`ZDOTDIR`, `PROMPT_COMMAND`, `XDG_DATA_DIRS`,
 * hook paths). It is switched on by carrying those variables, not by the execution-host intent's
 * `integration` field, which stays `"disabled"`: the host itself never injects an integration.
 *
 * @module localTerminalHost.launchSpec
 */
import type { ShellHostScope } from "@bigbud/contracts/workspace/terminalShell.ts";

import type { RemoteAgentPtyCreateDefaults } from "../remote-agent/remoteAgentPtyClient.lifecycle.ts";
import {
  parseRemoteAgentShellLaunch,
  type RemoteAgentShellLaunch,
} from "../remote-agent/remoteAgentShellLaunch.ts";
import {
  LOCAL_SHELL_HOST,
  shellKind,
  shellProfileId,
} from "../terminal/Layers/ShellProfiles.identity.ts";
import type { PtySpawnInput } from "../terminal/Services/PTY.ts";
import { shellIntegrationEnvIsStable } from "../terminal/shellIntegration/shellIntegration.ts";
import { resolveCommandPath } from "../utils/commandPath.ts";
import { LOCAL_TERMINAL_HOST_TARGET_ID } from "./localTerminalHost.paths.ts";

/** Mirrors the R5 local-launch validator (`protocol_helpers.environment.rs`). */
export const LOCAL_LAUNCH_MAX_ENTRIES = 512;
export const LOCAL_LAUNCH_MAX_BYTES = 256 * 1024;
export const LOCAL_LAUNCH_MAX_VALUE_BYTES = 16 * 1024;
const POSIX_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Every host PTY is lifecycle-managed and launched with the local environment. */
export const LOCAL_TERMINAL_HOST_LIFECYCLE: RemoteAgentPtyCreateDefaults = Object.freeze({
  lifecycleManaged: true,
  localLaunch: true,
});

export type LocalTerminalHostPlatform = "darwin" | "linux";

/** A launch spec the host cannot honour unchanged; the terminal runs in-process instead. */
export class LocalTerminalHostLaunchSpecError extends Error {
  readonly _tag = "LocalTerminalHostLaunchSpecError";
}

export function localTerminalHostPlatform(
  platform: NodeJS.Platform = process.platform,
): LocalTerminalHostPlatform {
  if (platform === "darwin" || platform === "linux") return platform;
  throw new LocalTerminalHostLaunchSpecError(`The terminal host does not run on ${platform}.`);
}

export function localTerminalHostShellHost(target: string): ShellHostScope {
  if (target !== LOCAL_TERMINAL_HOST_TARGET_ID)
    throw new Error("A local terminal host shell must name the local terminal host.");
  return { kind: "agent", hostId: LOCAL_TERMINAL_HOST_TARGET_ID };
}

/**
 * The server's spawn environment as `local_launch` entries, in insertion order. Like node-pty,
 * `PWD` names the requested cwd, so shells keep its logical spelling (`/tmp/x`) although the host
 * starts them in the canonical directory (`/private/tmp/x`). Entries the host would skip (a
 * non-POSIX name such as `BASH_FUNC_x%%`, a value over 16 KiB, or a NUL byte, which would fail
 * the whole create) are dropped here so the host never logs them. An environment over the host's
 * entry or size cap cannot launch unchanged and throws.
 */
export function localTerminalHostLaunchEnvironment(
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): ReadonlyArray<{ readonly name: string; readonly value: string }> {
  const entries: Array<{ readonly name: string; readonly value: string }> = [];
  let bytes = 0;
  const source = cwd === undefined ? environment : { ...environment, PWD: cwd };
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || !POSIX_NAME.test(name) || value.includes("\0")) continue;
    const size = Buffer.byteLength(value);
    if (size > LOCAL_LAUNCH_MAX_VALUE_BYTES) continue;
    bytes += Buffer.byteLength(name) + size;
    entries.push({ name, value });
  }
  if (entries.length > LOCAL_LAUNCH_MAX_ENTRIES)
    throw new LocalTerminalHostLaunchSpecError(
      `The terminal environment has ${entries.length} entries; the terminal host accepts ${LOCAL_LAUNCH_MAX_ENTRIES}.`,
    );
  if (bytes > LOCAL_LAUNCH_MAX_BYTES)
    throw new LocalTerminalHostLaunchSpecError(
      "The terminal environment exceeds the terminal host's 256 KiB limit.",
    );
  return entries;
}

/** Server-resolved local candidate as immutable Rust launch intent on the real platform. */
export function localTerminalHostShellLaunch(
  input: Pick<PtySpawnInput, "shell" | "args" | "cwd" | "env" | "shellProfile">,
  platform: LocalTerminalHostPlatform = localTerminalHostPlatform(),
): RemoteAgentShellLaunch {
  const host = localTerminalHostShellHost(LOCAL_TERMINAL_HOST_TARGET_ID);
  const args = [...(input.args ?? [])];
  const executable = input.shell.startsWith("/")
    ? input.shell
    : resolveCommandPath(input.shell, { platform, env: input.env });
  if (!executable) throw new Error("The requested terminal shell is unavailable on this computer.");
  const profile = input.shellProfile;
  if (profile?.selection.kind === "profile") {
    if (
      profile.host.kind !== "local" ||
      profile.host.hostId !== LOCAL_SHELL_HOST.hostId ||
      profile.profileId !== shellProfileId(LOCAL_SHELL_HOST, executable, args, platform) ||
      profile.kind !== shellKind(executable, platform)
    )
      throw new Error("The selected local shell profile does not match its resolved candidate.");
  }
  return parseRemoteAgentShellLaunch({
    version: 1,
    cwd: input.cwd,
    executable,
    args,
    platform,
    integration: "disabled",
    requestedProfile: {
      host,
      profileId: shellProfileId(host, executable, args, platform),
      kind: shellKind(executable, platform),
    },
  });
}

export interface LocalTerminalHostLaunchSpec {
  readonly shellLaunch: RemoteAgentShellLaunch;
  readonly environment: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly hostLifecycle: RemoteAgentPtyCreateDefaults;
}

/**
 * The complete create intent for a new host terminal. A terminal outlives the backend in the
 * host, so its hook environment must name files under `<stateDir>` (the content-addressed
 * shell-integration root), which every later backend reinstalls at the same path. A spec that
 * cannot hold (unstable hook paths, an oversized environment) throws
 * `LocalTerminalHostLaunchSpecError`, and the caller runs that terminal in-process.
 */
export function localTerminalHostLaunchSpec(
  input: Pick<PtySpawnInput, "shell" | "args" | "cwd" | "env" | "shellProfile">,
  options: { readonly stateDir: string; readonly platform?: NodeJS.Platform },
): LocalTerminalHostLaunchSpec {
  const platform = localTerminalHostPlatform(options.platform);
  if (!shellIntegrationEnvIsStable(input.env, options.stateDir))
    throw new LocalTerminalHostLaunchSpecError(
      "The terminal hook environment is not under the server state directory.",
    );
  return {
    shellLaunch: localTerminalHostShellLaunch(input, platform),
    environment: localTerminalHostLaunchEnvironment(input.env, input.cwd),
    hostLifecycle: LOCAL_TERMINAL_HOST_LIFECYCLE,
  };
}

export type LocalTerminalHostLaunchPlan =
  | { readonly kind: "host"; readonly spec: LocalTerminalHostLaunchSpec }
  | { readonly kind: "in-process"; readonly reason: string };

/** Whether a new terminal can launch in the host unchanged; other launch errors still throw. */
export function planLocalTerminalHostLaunch(
  input: Pick<PtySpawnInput, "shell" | "args" | "cwd" | "env" | "shellProfile">,
  options: { readonly stateDir: string; readonly platform?: NodeJS.Platform },
): LocalTerminalHostLaunchPlan {
  try {
    return { kind: "host", spec: localTerminalHostLaunchSpec(input, options) };
  } catch (cause) {
    if (cause instanceof LocalTerminalHostLaunchSpecError)
      return { kind: "in-process", reason: cause.message };
    throw cause;
  }
}
