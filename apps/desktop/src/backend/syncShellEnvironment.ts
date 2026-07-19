import {
  readEnvironmentFromLoginShell,
  readEnvironmentFromLoginShellAsync,
  resolveLoginShell,
  ShellEnvironmentReader,
  ShellEnvironmentReaderAsync,
} from "@bigbud/shared/shell";

// CLIProxy is an environment-only experiment. Remove these entries with its
// registration when deleting the experiment; no other provider reads them.
const LOGIN_SHELL_ENVIRONMENT_NAMES = [
  "PATH",
  "SSH_AUTH_SOCK",
  "BIGBUD_EXPERIMENTAL_CLIPROXY",
  "BIGBUD_CLIPROXY_BASE_URL",
  "BIGBUD_CLIPROXY_API_KEY",
  "BIGBUD_CLIPROXY_MANAGEMENT_KEY",
] as const;
const CLI_PROXY_ENVIRONMENT_NAMES = LOGIN_SHELL_ENVIRONMENT_NAMES.slice(2);

function applyShellEnvironment(env: NodeJS.ProcessEnv, shellEnvironment: NodeJS.ProcessEnv): void {
  if (shellEnvironment.PATH) {
    env.PATH = shellEnvironment.PATH;
  }

  if (!env.SSH_AUTH_SOCK && shellEnvironment.SSH_AUTH_SOCK) {
    env.SSH_AUTH_SOCK = shellEnvironment.SSH_AUTH_SOCK;
  }

  for (const name of CLI_PROXY_ENVIRONMENT_NAMES) {
    if (!env[name] && shellEnvironment[name]) {
      env[name] = shellEnvironment[name];
    }
  }
}

export function syncShellEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    platform?: NodeJS.Platform;
    readEnvironment?: ShellEnvironmentReader;
  } = {},
): void {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") return;

  try {
    const shell = resolveLoginShell(platform, env.SHELL);
    if (!shell) return;

    const shellEnvironment = (options.readEnvironment ?? readEnvironmentFromLoginShell)(
      shell,
      LOGIN_SHELL_ENVIRONMENT_NAMES,
    );
    applyShellEnvironment(env, shellEnvironment);
  } catch {
    // Keep inherited environment if shell lookup fails.
  }
}

export async function syncShellEnvironmentAsync(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    platform?: NodeJS.Platform;
    readEnvironment?: ShellEnvironmentReaderAsync;
  } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") return;

  try {
    const shell = resolveLoginShell(platform, env.SHELL);
    if (!shell) return;

    const shellEnvironment = await (options.readEnvironment ?? readEnvironmentFromLoginShellAsync)(
      shell,
      LOGIN_SHELL_ENVIRONMENT_NAMES,
    );
    applyShellEnvironment(env, shellEnvironment);
  } catch {
    // Keep inherited environment if shell lookup fails.
  }
}
