import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  isProviderConfig,
  readProviderConfig,
  writeProviderConfig,
  withProviderConfigMigration,
  type ProviderConfig,
} from "../../providerConfigMigration.ts";

const oldAzure = "azure-openai-responses";
const renameModel = (value: string) =>
  value.startsWith(`${oldAzure}/`) ? `azure/${value.slice(oldAzure.length + 1)}` : value;

function renameAzure(record: ProviderConfig) {
  if (!Object.hasOwn(record, oldAzure)) return;
  if (!Object.hasOwn(record, "azure")) record.azure = record[oldAzure];
  delete record[oldAzure];
}

function migrateCompatibility(value: unknown) {
  if (!isProviderConfig(value) || !isProviderConfig(value.compat)) return;
  const compat = value.compat;
  if (typeof compat.sendSessionIdHeader !== "boolean") return;
  if (!Object.hasOwn(compat, "sessionAffinityFormat")) {
    compat.sessionAffinityFormat = compat.sendSessionIdHeader ? "openai" : "openai-nosession";
  }
  delete compat.sendSessionIdHeader;
}

/** Transform only documented schema changes, never arbitrary extension code or proxy URLs. */
export function migratePiConfig(kind: "auth" | "models" | "settings", original: ProviderConfig) {
  const value = structuredClone(original);
  if (kind === "auth") renameAzure(value);
  if (kind === "settings") {
    if (value.defaultProvider === oldAzure) value.defaultProvider = "azure";
    if (Array.isArray(value.enabledModels)) {
      value.enabledModels = value.enabledModels.map((item) =>
        typeof item === "string" ? renameModel(item) : item,
      );
    }
    if (isProviderConfig(value.modelThinkingLevels)) {
      const levels = value.modelThinkingLevels;
      for (const key of Object.keys(levels)) {
        const next = renameModel(key);
        if (next === key) continue;
        if (!Object.hasOwn(levels, next)) levels[next] = levels[key];
        delete levels[key];
      }
    }
  }
  if (kind === "models" && isProviderConfig(value.providers)) {
    renameAzure(value.providers);
    for (const [name, provider] of Object.entries(value.providers)) {
      if (!isProviderConfig(provider)) continue;
      migrateCompatibility(provider);
      if (Array.isArray(provider.models)) provider.models.forEach(migrateCompatibility);
      if (name === "kimi-coding" && typeof provider.baseUrl === "string") {
        if (/^https:\/\/api\.kimi\.com\/coding\/?$/.test(provider.baseUrl)) {
          provider.baseUrl = "https://api.kimi.com/coding/v1";
        } else if (!provider.baseUrl.replace(/\/$/, "").endsWith("/v1")) {
          console.warn(
            "Pi configuration migration: verify the custom kimi-coding baseUrl includes its Chat Completions /v1 path; left unchanged.",
          );
        }
      }
    }
  }
  return value;
}

/** Migrate local bundled Pi configuration, including the selected local project's settings. */
export async function migrateBundledPiConfig(env: NodeJS.ProcessEnv, cwd?: string) {
  const configured = env.PI_CODING_AGENT_DIR;
  const agentDir = configured
    ? resolve(cwd ?? process.cwd(), configured.replace(/^~(?=$|\/)/, homedir()))
    : join(homedir(), ".pi", "agent");
  const files = [
    { path: join(agentDir, "auth.json"), kind: "auth" as const },
    { path: join(agentDir, "models.json"), kind: "models" as const },
    { path: join(agentDir, "settings.json"), kind: "settings" as const },
    ...(cwd ? [{ path: join(cwd, ".pi", "settings.json"), kind: "settings" as const }] : []),
  ];
  for (const { path, kind } of files) {
    await withProviderConfigMigration(path, async () => {
      const original = await readProviderConfig(path);
      if (original)
        await writeProviderConfig(path, original, migratePiConfig(kind, original.value));
    });
  }
}
