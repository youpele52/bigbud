import { homedir } from "node:os";

import type { ModelCapabilities, ProviderKind, ServerProviderModel } from "@bigbud/contracts";
import { Effect, FileSystem, Path } from "effect";

const MODELS_PER_FALLBACK_PROVIDER = 5;
const PROVIDER_PRIORITY = [
  "opencode",
  "kilo",
  "anthropic",
  "openai",
  "google",
  "github-copilot",
  "openrouter",
  "deepseek",
  "xai",
  "groq",
  "cerebras",
  "amazon-bedrock",
  "azure",
] as const;

export const MANAGED_SERVER_EMPTY_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

function model(
  slug: string,
  name: string,
  group: string,
  subProviderID: string,
  reasoning = false,
): ServerProviderModel {
  return {
    slug,
    name,
    isCustom: false,
    group,
    subProviderID,
    capabilities: {
      ...MANAGED_SERVER_EMPTY_MODEL_CAPABILITIES,
      reasoningEffortLevels: reasoning
        ? [
            { value: "high", label: "High", isDefault: true },
            { value: "medium", label: "Medium" },
            { value: "low", label: "Low" },
          ]
        : [],
    },
  };
}

/** Small bundled safety net used only when the provider's Models.dev cache is unavailable. */
export function managedServerBuiltInModels(
  provider: Extract<ProviderKind, "kilocode" | "opencode">,
): ReadonlyArray<ServerProviderModel> {
  const gatewayModels =
    provider === "opencode"
      ? [
          model("deepseek-v4-flash", "DeepSeek V4 Flash", "OpenCode Zen", "opencode", true),
          model("claude-opus-5", "Claude Opus 5", "OpenCode Zen", "opencode", true),
          model("gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite", "OpenCode Zen", "opencode", true),
        ]
      : [
          model("sakana/sakana-namazu", "Sakana Namazu", "Kilo Gateway", "kilo", true),
          model("upstage/solar-pro4", "Solar Pro 4", "Kilo Gateway", "kilo", true),
          model("qwen/qwen3.8-max", "Qwen3.8 Max", "Kilo Gateway", "kilo", true),
        ];

  return [
    ...gatewayModels,
    model("gpt-5.6-sol", "GPT-5.6 Sol", "OpenAI", "openai", true),
    model("gpt-5.6-luna", "GPT-5.6 Luna", "OpenAI", "openai", true),
    model("claude-opus-5", "Claude Opus 5", "Anthropic", "anthropic", true),
    model("claude-sonnet-5", "Claude Sonnet 5", "Anthropic", "anthropic", true),
    model("gemini-3.6-flash", "Gemini 3.6 Flash", "Google", "google", true),
    model("gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite", "Google", "google", true),
    model("deepseek-v4-pro", "DeepSeek V4 Pro", "DeepSeek", "deepseek", true),
    model("deepseek-v4-flash", "DeepSeek V4 Flash", "DeepSeek", "deepseek", true),
  ];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function priority(providerID: string): number {
  const index = PROVIDER_PRIORITY.indexOf(providerID as (typeof PROVIDER_PRIORITY)[number]);
  return index === -1 ? PROVIDER_PRIORITY.length : index;
}

export function modelsFromModelsDevCache(encoded: string): ReadonlyArray<ServerProviderModel> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(encoded);
  } catch {
    return [];
  }
  const catalog = asRecord(decoded);
  if (!catalog) return [];

  const providers = Object.entries(catalog).toSorted(([leftID, left], [rightID, right]) => {
    const rank = priority(leftID) - priority(rightID);
    if (rank !== 0) return rank;
    const leftName = asRecord(left)?.name;
    const rightName = asRecord(right)?.name;
    return String(leftName ?? leftID).localeCompare(String(rightName ?? rightID));
  });
  const result: ServerProviderModel[] = [];

  for (const [providerKey, rawProvider] of providers) {
    const provider = asRecord(rawProvider);
    const rawModels = asRecord(provider?.models);
    if (!provider || !rawModels) continue;
    const providerID = typeof provider.id === "string" ? provider.id : providerKey;
    const providerName = typeof provider.name === "string" ? provider.name : providerID;
    const models = Object.entries(rawModels)
      .flatMap(([modelKey, rawModel]) => {
        const entry = asRecord(rawModel);
        if (!entry || entry.status === "deprecated") return [];
        const slug = typeof entry.id === "string" ? entry.id : modelKey;
        const name = typeof entry.name === "string" ? entry.name : slug;
        const updatedAt =
          typeof entry.last_updated === "string"
            ? entry.last_updated
            : typeof entry.release_date === "string"
              ? entry.release_date
              : "";
        return [{ slug, name, updatedAt, reasoning: entry.reasoning === true }];
      })
      .toSorted(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name),
      )
      .slice(0, MODELS_PER_FALLBACK_PROVIDER);

    for (const entry of models) {
      result.push(model(entry.slug, entry.name, providerName, providerID, entry.reasoning));
    }
  }

  return result;
}

function modelsDevCacheRoot(): string {
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA ?? process.env.APPDATA ?? homedir();
  }
  return process.env.XDG_CACHE_HOME ?? `${homedir()}/.cache`;
}

export const loadManagedServerFallbackModels = Effect.fn("loadManagedServerFallbackModels")(
  function* (provider: Extract<ProviderKind, "kilocode" | "opencode">) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cacheName = provider === "opencode" ? "opencode" : "kilo";
    const encoded = yield* fs
      .readFileString(path.join(modelsDevCacheRoot(), cacheName, "models.json"))
      .pipe(Effect.orElseSucceed(() => ""));
    const cached = modelsFromModelsDevCache(encoded);
    return {
      models: cached.length > 0 ? cached : managedServerBuiltInModels(provider),
      source: cached.length > 0 ? `${cacheName}-models-dev-cache` : "bundled-fallback",
    } as const;
  },
);
