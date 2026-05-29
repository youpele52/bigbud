import type {
  ModelCapabilities,
  ServerProviderModel,
  ServerProviderSlashCommand,
} from "@bigbud/contracts";
import {
  type ModelInfo as ClaudeModelInfo,
  query as claudeQuery,
  type SDKUserMessage,
  type SlashCommand as ClaudeSlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import { Effect } from "effect";

export const DEFAULT_CLAUDE_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  // Claude "ultrathink" is a prompt keyword rather than a runtime effort option.
  // Keep this enabled even for unknown models so `/effort ultrathink` still works.
  promptInjectedEffortLevels: ["ultrathink"],
};

const CLAUDE_LEGACY_MODEL_ALIASES = new Map<string, string>([
  ["default", "default"],
  ["sonnet", "default"],
  ["claude-sonnet-4.6", "default"],
  ["claude-sonnet-4-6", "default"],
  ["claude-sonnet-4-6-20251117", "default"],
  ["opus", "opus"],
  ["claude-opus-4.6", "opus"],
  ["claude-opus-4-6", "opus"],
  ["claude-opus-4-6-20251117", "opus"],
  ["claude-opus-4-5", "opus"],
  ["haiku", "haiku"],
  ["claude-haiku-4.5", "haiku"],
  ["claude-haiku-4-5", "haiku"],
  ["claude-haiku-4-5-20251001", "haiku"],
]);

function resolveClaudeCapabilitySlug(model: string | null | undefined): string | null {
  const trimmed = model?.trim();
  if (!trimmed) {
    return null;
  }

  return CLAUDE_LEGACY_MODEL_ALIASES.get(trimmed) ?? trimmed;
}

export const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "default",
    name: "Claude Sonnet 4.6",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High", isDefault: true },
      ],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [
        { value: "200k", label: "200k", isDefault: true },
        { value: "1m", label: "1M" },
      ],
      promptInjectedEffortLevels: ["ultrathink"],
    },
  },
  {
    slug: "opus",
    name: "Claude Opus 4.6",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High", isDefault: true },
        { value: "max", label: "Max" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [
        { value: "200k", label: "200k", isDefault: true },
        { value: "1m", label: "1M" },
      ],
      promptInjectedEffortLevels: ["ultrathink"],
    },
  },
  {
    slug: "haiku",
    name: "Claude Haiku 4.5",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [],
      supportsFastMode: false,
      supportsThinkingToggle: true,
      contextWindowOptions: [],
      promptInjectedEffortLevels: ["ultrathink"],
    },
  },
];

export function getClaudeModelCapabilities(model: string | null | undefined): ModelCapabilities {
  const slug = resolveClaudeCapabilitySlug(model);
  return (
    BUILT_IN_MODELS.find((candidate) => candidate.slug === slug)?.capabilities ??
    DEFAULT_CLAUDE_MODEL_CAPABILITIES
  );
}

function getClaudeDefaultEffort(
  modelSlug: string,
  levels: ReadonlyArray<NonNullable<ClaudeModelInfo["supportedEffortLevels"]>[number]>,
): string | undefined {
  if ((modelSlug === "default" || modelSlug === "opus") && levels.includes("high")) {
    return "high";
  }
  if (levels.includes("medium")) {
    return "medium";
  }
  return levels[0];
}

function mapClaudeModelCapabilities(model: ClaudeModelInfo): ModelCapabilities {
  const baseCapabilities = getClaudeModelCapabilities(model.value);
  const supportedEffortLevels = model.supportsEffort ? (model.supportedEffortLevels ?? []) : [];
  const defaultEffort = getClaudeDefaultEffort(model.value, supportedEffortLevels);
  return {
    reasoningEffortLevels: supportedEffortLevels.map((value) => {
      const option: {
        value: string;
        label: string;
        isDefault?: true;
      } = {
        value,
        label: value === "xhigh" ? "Extra High" : value.charAt(0).toUpperCase() + value.slice(1),
      };
      if (value === defaultEffort) {
        option.isDefault = true;
      }
      return option;
    }),
    supportsFastMode: model.supportsFastMode ?? baseCapabilities.supportsFastMode,
    supportsThinkingToggle:
      model.supportsAdaptiveThinking ?? baseCapabilities.supportsThinkingToggle,
    contextWindowOptions: baseCapabilities.contextWindowOptions,
    promptInjectedEffortLevels: baseCapabilities.promptInjectedEffortLevels,
  };
}

export function mapClaudeModel(model: ClaudeModelInfo): ServerProviderModel {
  return {
    slug: model.value,
    name: model.displayName,
    isCustom: false,
    capabilities: mapClaudeModelCapabilities(model),
  };
}

const CAPABILITIES_PROBE_TIMEOUT_MS = 8_000;

function nonEmptyProbeString(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function dedupeSlashCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const commandsByName = new Map<string, ServerProviderSlashCommand>();

  for (const command of commands) {
    const name = nonEmptyProbeString(command.name);
    if (!name) {
      continue;
    }

    const key = name.toLowerCase();
    const existing = commandsByName.get(key);
    if (!existing) {
      commandsByName.set(key, { ...command, name });
      continue;
    }

    commandsByName.set(key, {
      ...existing,
      ...(existing.description
        ? {}
        : command.description
          ? { description: command.description }
          : {}),
      ...(existing.input?.hint
        ? {}
        : command.input?.hint
          ? { input: { hint: command.input.hint } }
          : {}),
    });
  }

  return [...commandsByName.values()];
}

function parseClaudeInitializationCommands(
  commands: ReadonlyArray<ClaudeSlashCommand> | undefined,
): ReadonlyArray<ServerProviderSlashCommand> {
  return dedupeSlashCommands(
    (commands ?? []).flatMap((command) => {
      const name = nonEmptyProbeString(command.name);
      if (!name) {
        return [];
      }

      const description = nonEmptyProbeString(command.description);
      const argumentHint = nonEmptyProbeString(command.argumentHint);

      return [
        {
          name,
          ...(description ? { description } : {}),
          ...(argumentHint ? { input: { hint: argumentHint } } : {}),
        } satisfies ServerProviderSlashCommand,
      ];
    }),
  );
}

function waitForAbortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export const probeClaudeCapabilities = (binaryPath: string) =>
  Effect.tryPromise(async () => {
    const abortController = new AbortController();
    const queryRuntime = claudeQuery({
      // oxlint-disable-next-line require-yield
      prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
        await waitForAbortSignal(abortController.signal);
      })(),
      options: {
        pathToClaudeCodeExecutable: binaryPath,
        abortController,
        settingSources: ["user", "project", "local"],
        allowedTools: [],
        stderr: () => {},
      },
    });

    try {
      const init = await queryRuntime.initializationResult();
      return {
        subscriptionType: init.account?.subscriptionType,
        slashCommands: parseClaudeInitializationCommands(init.commands),
        models: (init.models ?? []).map(mapClaudeModel),
      };
    } finally {
      abortController.abort();
      queryRuntime.close();
    }
  }).pipe(Effect.timeout(CAPABILITIES_PROBE_TIMEOUT_MS));
