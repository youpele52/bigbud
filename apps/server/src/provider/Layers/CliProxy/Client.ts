import type { CliProxyConfig } from "./config.ts";
import { CLI_PROXY_HEALTH_PATH } from "./config.ts";

const REQUEST_TIMEOUT_MS = 4_000;
const MANAGEMENT_BASE_PATH = "/v0/management";
const HEALTHY_AUTH_FILE_STATUSES = new Set(["success", "ready", "active"]);

export type CliProxySource = "codex" | "claude";

export interface CliProxyModel {
  readonly id: string;
  readonly source: CliProxySource;
  readonly displayName?: string;
}

export interface CliProxyPreflight {
  readonly health: boolean;
  readonly sources: ReadonlySet<CliProxySource>;
  readonly models: ReadonlyArray<CliProxyModel>;
}

interface AuthFile {
  readonly id: string;
  readonly name: string;
  readonly provider: CliProxySource;
  readonly status: string;
  readonly disabled?: boolean;
  readonly unavailable?: boolean;
}

function request(url: URL, headers?: Readonly<Record<string, string>>): Promise<Response> {
  return fetch(url, {
    ...(headers ? { headers } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function managementUrl(config: CliProxyConfig, pathname: string): URL {
  return new URL(`${MANAGEMENT_BASE_PATH}${pathname}`, config.baseUrl);
}

function healthyAuthFiles(value: unknown): ReadonlyArray<AuthFile> {
  if (!value || typeof value !== "object" || !Array.isArray((value as { files?: unknown }).files)) {
    return [];
  }
  return (value as { files: ReadonlyArray<unknown> }).files.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const entry = candidate as Partial<AuthFile>;
    if (
      (entry.provider !== "codex" && entry.provider !== "claude") ||
      typeof entry.id !== "string" ||
      typeof entry.name !== "string" ||
      typeof entry.status !== "string" ||
      entry.disabled === true ||
      entry.unavailable === true ||
      !HEALTHY_AUTH_FILE_STATUSES.has(entry.status)
    ) {
      return [];
    }
    return [entry as AuthFile];
  });
}

function modelsFromResponse(value: unknown, source: CliProxySource): ReadonlyArray<CliProxyModel> {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as { models?: unknown }).models)
  ) {
    return [];
  }
  return (value as { models: ReadonlyArray<unknown> }).models.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const model = candidate as { id?: unknown; display_name?: unknown };
    if (typeof model.id !== "string" || model.id.trim().length === 0) return [];
    return [
      {
        id: model.id,
        source,
        ...(typeof model.display_name === "string" ? { displayName: model.display_name } : {}),
      },
    ];
  });
}

export async function preflightCliProxy(config: CliProxyConfig): Promise<CliProxyPreflight> {
  const health = await request(new URL(CLI_PROXY_HEALTH_PATH, config.baseUrl));
  if (!health.ok) return { health: false, sources: new Set(), models: [] };

  const apiModels = await request(new URL("/v1/models", config.baseUrl), {
    Authorization: `Bearer ${config.apiKey}`,
  });
  if (!apiModels.ok) return { health: true, sources: new Set(), models: [] };

  const headers = { Authorization: `Bearer ${config.managementKey}` };
  const authFilesResponse = await request(managementUrl(config, "/auth-files"), headers);
  if (!authFilesResponse.ok) return { health: true, sources: new Set(), models: [] };
  const authFiles = healthyAuthFiles(await authFilesResponse.json());
  const sources = new Set(authFiles.map((file) => file.provider));
  const discovered = await Promise.all(
    authFiles.map(async (file) => {
      const url = managementUrl(config, `/auth-files/models?name=${encodeURIComponent(file.id)}`);
      const response = await request(url, headers);
      return response.ok ? modelsFromResponse(await response.json(), file.provider) : [];
    }),
  );
  const seen = new Set<string>();
  const models = discovered.flat().filter((model) => {
    const key = `${model.source}:${model.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { health: true, sources, models };
}
