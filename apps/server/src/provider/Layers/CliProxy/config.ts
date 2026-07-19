/** Environment-only configuration for the removable CLIProxy experiment. */
export interface CliProxyConfig {
  readonly baseUrl: URL;
  readonly apiKey: string;
  readonly managementKey: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const HARNESS_ENVIRONMENT_NAMES = ["PATH", "HOME", "USERPROFILE"] as const;
export const CLI_PROXY_HEALTH_PATH = "/healthz";
export const CLI_PROXY_ENVIRONMENT_NAMES = [
  "BIGBUD_EXPERIMENTAL_CLIPROXY",
  "BIGBUD_CLIPROXY_BASE_URL",
  "BIGBUD_CLIPROXY_API_KEY",
  "BIGBUD_CLIPROXY_MANAGEMENT_KEY",
] as const;

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function runtimeHarnessEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    HARNESS_ENVIRONMENT_NAMES.flatMap((name) => (env[name] ? [[name, env[name]]] : [])),
  );
}

export function isCliProxyExperimentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BIGBUD_EXPERIMENTAL_CLIPROXY === "1";
}

export function readCliProxyConfig(
  env: NodeJS.ProcessEnv = process.env,
): CliProxyConfig | undefined {
  if (!isCliProxyExperimentEnabled(env)) return undefined;
  const baseUrl = requiredEnv(env, "BIGBUD_CLIPROXY_BASE_URL");
  const apiKey = requiredEnv(env, "BIGBUD_CLIPROXY_API_KEY");
  const managementKey = requiredEnv(env, "BIGBUD_CLIPROXY_MANAGEMENT_KEY");
  if (!baseUrl || !apiKey || !managementKey) return undefined;

  try {
    const url = new URL(baseUrl);
    if (
      url.protocol !== "http:" ||
      !LOOPBACK_HOSTS.has(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return { baseUrl: url, apiKey, managementKey };
  } catch {
    return undefined;
  }
}

export function cliProxyHarnessEnvironment(
  config: CliProxyConfig,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return {
    ...runtimeHarnessEnvironment(env),
    ANTHROPIC_BASE_URL: config.baseUrl.toString().replace(/\/$/, ""),
    ANTHROPIC_AUTH_TOKEN: config.apiKey,
    ANTHROPIC_API_KEY: "",
  };
}
