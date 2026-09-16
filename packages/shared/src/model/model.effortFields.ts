import type {
  ClaudeModelOptions,
  CopilotModelOptions,
  CodexModelOptions,
  CursorModelOptions,
  DevinModelOptions,
  KilocodeModelOptions,
  OpencodeModelOptions,
  PiModelOptions,
  ProviderKind,
  ProviderModelOptions,
} from "@bigbud/contracts";

import { trimOrNull } from "./model.strings";

type ProviderOptions = ProviderModelOptions[ProviderKind];

export type ProviderEffortField = "reasoningEffort" | "effort" | "reasoning" | "thinkingLevel";

export function getProviderEffortField(provider: ProviderKind): ProviderEffortField | null {
  switch (provider) {
    case "codex":
    case "copilot":
    case "opencode":
    case "kilocode":
      return "reasoningEffort";
    case "claudeAgent":
      return "effort";
    case "cursor":
    case "devin":
      return "reasoning";
    case "pi":
      return "thinkingLevel";
    case "cliProxy":
      return null;
  }
}

export function getRawProviderEffort(
  provider: ProviderKind,
  modelOptions: ProviderOptions | null | undefined,
): string | null {
  if (!modelOptions) return null;
  const field = getProviderEffortField(provider);
  if (field === null) return null;
  if (provider === "cursor" || provider === "devin") {
    const options = modelOptions as CursorModelOptions &
      DevinModelOptions & { reasoningEffort?: string };
    return trimOrNull(options.reasoning) ?? trimOrNull(options.reasoningEffort);
  }
  return trimOrNull((modelOptions as Record<string, unknown>)[field] as string | undefined);
}

export function patchProviderEffort(
  provider: ProviderKind,
  modelOptions: ProviderOptions | null | undefined,
  effort: string | undefined,
): ProviderOptions | undefined {
  const field = getProviderEffortField(provider);
  const next: Record<string, unknown> = modelOptions ? { ...modelOptions } : {};
  if (provider === "cursor" || provider === "devin") {
    delete next.reasoningEffort;
  }
  if (!field) {
    return Object.keys(next).length > 0 ? (next as ProviderOptions) : undefined;
  }
  if (effort === undefined) {
    delete next[field];
  } else {
    next[field] = effort;
  }
  return Object.keys(next).length > 0 ? (next as ProviderOptions) : undefined;
}

export function buildNextProviderOptions(
  provider: ProviderKind,
  modelOptions: ProviderOptions | null | undefined,
  patch: Record<string, unknown>,
): ProviderOptions {
  const merged = { ...(modelOptions as Record<string, unknown> | undefined), ...patch };
  if ("reasoningEffort" in patch && (provider === "cursor" || provider === "devin")) {
    delete merged.reasoningEffort;
    merged.reasoning = patch.reasoningEffort;
  }
  switch (provider) {
    case "codex":
      return merged as CodexModelOptions;
    case "copilot":
      return merged as CopilotModelOptions;
    case "opencode":
      return merged as OpencodeModelOptions;
    case "kilocode":
      return merged as KilocodeModelOptions;
    case "pi":
      return merged as PiModelOptions;
    case "cursor":
      return merged as CursorModelOptions;
    case "devin":
      return merged as DevinModelOptions;
    case "claudeAgent":
      return merged as ClaudeModelOptions;
    case "cliProxy":
      return merged as ProviderModelOptions["cliProxy"];
  }
}
