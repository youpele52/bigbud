import {
  readEnvironmentFromLoginShell,
  readEnvironmentFromLoginShellAsync,
  mergePathEntries,
  resolveLoginShell,
  ShellEnvironmentReader,
  ShellEnvironmentReaderAsync,
} from "@bigbud/shared/shell";

/**
 * U11: `SSH_AUTH_SOCK` is the owner's agent-policy input on desktop (D) and
 * dev (V) only. Standalone Node (N) and remote (R) use the profile environment.
 * This function records the rule; only the desktop main process calls it.
 */
export type ShellEnvironmentProfile = "D" | "V" | "N" | "R";

export function importsSshAuthSock(profile: ShellEnvironmentProfile): boolean {
  return profile === "D" || profile === "V";
}

function shellVariables(profile: ShellEnvironmentProfile) {
  return importsSshAuthSock(profile) ? (["PATH", "SSH_AUTH_SOCK"] as const) : (["PATH"] as const);
}

export function syncShellEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    platform?: NodeJS.Platform;
    readEnvironment?: ShellEnvironmentReader;
    profile?: ShellEnvironmentProfile;
  } = {},
): void {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") return;
  const profile = options.profile ?? "D";
  const allowSshAuthSock = importsSshAuthSock(profile);

  try {
    const shell = resolveLoginShell(platform, env.SHELL);
    if (!shell) return;

    const shellEnvironment = (options.readEnvironment ?? readEnvironmentFromLoginShell)(shell, [
      ...shellVariables(profile),
    ]);

    if (shellEnvironment.PATH) {
      env.PATH = mergePathEntries(shellEnvironment.PATH, env.PATH, platform);
    }

    if (allowSshAuthSock && !env.SSH_AUTH_SOCK && shellEnvironment.SSH_AUTH_SOCK) {
      env.SSH_AUTH_SOCK = shellEnvironment.SSH_AUTH_SOCK;
    }
  } catch {
    // Keep inherited environment if shell lookup fails.
  }
}

export async function syncShellEnvironmentAsync(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    platform?: NodeJS.Platform;
    readEnvironment?: ShellEnvironmentReaderAsync;
    profile?: ShellEnvironmentProfile;
  } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") return;
  const profile = options.profile ?? "D";
  const allowSshAuthSock = importsSshAuthSock(profile);

  try {
    const shell = resolveLoginShell(platform, env.SHELL);
    if (!shell) return;

    const shellEnvironment = await (options.readEnvironment ?? readEnvironmentFromLoginShellAsync)(
      shell,
      [...shellVariables(profile)],
    );

    if (shellEnvironment.PATH) {
      env.PATH = mergePathEntries(shellEnvironment.PATH, env.PATH, platform);
    }

    if (allowSshAuthSock && !env.SSH_AUTH_SOCK && shellEnvironment.SSH_AUTH_SOCK) {
      env.SSH_AUTH_SOCK = shellEnvironment.SSH_AUTH_SOCK;
    }
  } catch {
    // Keep inherited environment if shell lookup fails.
  }
}
