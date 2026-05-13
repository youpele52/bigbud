import type {
  ModelCapabilities,
  ServerProviderModel,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@bigbud/contracts";

import { providerModelsFromSettings } from "../../providerSnapshot";
import type { PiRpcModel, PiRpcSlashCommand } from "./RpcProcess.ts";

const PROVIDER = "pi" as const;

/** Maps raw Pi provider IDs to user-friendly display names for model grouping. */
export const PI_PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  "github-copilot": "GitHub Copilot",
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  gemini: "Google",
  groq: "Groq",
  openrouter: "OpenRouter",
  xai: "xAI",
  "x.ai": "xAI",
  deepseek: "DeepSeek",
  cohere: "Cohere",
  ai21: "AI21",
  perplexity: "Perplexity",
  mistral: "Mistral",
  opencode: "OpenCode",
  "opencode-go": "OpenCode Go",
};

export function getPiProviderDisplayName(rawProvider: string): string {
  return PI_PROVIDER_DISPLAY_NAMES[rawProvider] ?? rawProvider;
}

export const EMPTY_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

export function buildPiModels(
  models: ReadonlyArray<PiRpcModel>,
  customModels: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderModel> {
  const builtInModels = models.map(
    (model) =>
      ({
        slug: model.id,
        name: model.name.trim().length > 0 ? model.name : model.id,
        isCustom: false,
        group: getPiProviderDisplayName(model.provider),
        subProviderID: model.provider,
        capabilities: EMPTY_MODEL_CAPABILITIES,
      }) satisfies ServerProviderModel,
  );

  return providerModelsFromSettings(
    builtInModels,
    PROVIDER,
    customModels,
    EMPTY_MODEL_CAPABILITIES,
  );
}

function dedupeSlashCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const deduped = new Map<string, ServerProviderSlashCommand>();

  for (const command of commands) {
    const name = command.name.trim();
    if (!name) {
      continue;
    }

    const key = name.toLowerCase();
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, { ...command, name });
      continue;
    }

    deduped.set(key, {
      ...existing,
      ...(existing.description
        ? {}
        : command.description
          ? { description: command.description }
          : {}),
    });
  }

  return [...deduped.values()];
}

export function mapPiSlashCommands(
  commands: ReadonlyArray<PiRpcSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  return dedupeSlashCommands(
    commands.flatMap((command) => {
      const name = command.name.trim();
      if (!name) {
        return [];
      }

      const description = command.description?.trim();
      return [
        {
          name,
          ...(description ? { description } : {}),
        } satisfies ServerProviderSlashCommand,
      ];
    }),
  );
}

function normalizePiSkillName(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed.startsWith("skill:")) {
    return undefined;
  }

  const skillName = trimmed.slice("skill:".length).trim();
  return skillName.length > 0 ? skillName : undefined;
}

export function buildPiSkills(
  commands: ReadonlyArray<PiRpcSlashCommand>,
): ReadonlyArray<ServerProviderSkill> {
  const deduped = new Map<string, ServerProviderSkill>();

  for (const command of commands) {
    if (command.source !== "skill") {
      continue;
    }

    const name = normalizePiSkillName(command.name);
    const sourcePath = command.sourceInfo?.path?.trim();
    if (!name || !sourcePath) {
      continue;
    }

    const key = name.toLowerCase();
    const existing = deduped.get(key);
    if (existing) {
      if (!existing.description && command.description?.trim()) {
        deduped.set(key, {
          ...existing,
          description: command.description.trim(),
        });
      }
      continue;
    }

    deduped.set(key, {
      name,
      path: sourcePath,
      enabled: true,
      ...(command.description?.trim() ? { description: command.description.trim() } : {}),
      ...(command.sourceInfo?.scope ? { scope: command.sourceInfo.scope } : {}),
    } satisfies ServerProviderSkill);
  }

  return [...deduped.values()];
}

export function inferPiAuthStatus(input: {
  readonly models: ReadonlyArray<PiRpcModel>;
  readonly detail?: string;
}): {
  readonly status: "ready" | "error";
  readonly auth: "authenticated" | "unauthenticated" | "unknown";
  readonly message?: string;
} {
  if (input.models.length > 0) {
    return {
      status: "ready",
      auth: "authenticated",
    };
  }

  const detail = input.detail?.trim();
  const lower = detail?.toLowerCase() ?? "";
  const unauthenticated =
    lower.includes("api key") ||
    lower.includes("oauth") ||
    lower.includes("credential") ||
    lower.includes("not authenticated") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("login");

  return {
    status: "error",
    auth: unauthenticated ? "unauthenticated" : "unknown",
    message:
      detail && detail.length > 0
        ? detail
        : "Pi is installed but no models are available. Configure a provider in Pi and try again.",
  };
}
