import {
  type ProviderKind,
  type ProviderModelOptions,
  type ServerProviderModel,
  type ThreadId,
} from "@bigbud/contracts";
import {
  isClaudeUltrathinkPrompt,
  normalizeClaudeModelOptionsWithCapabilities,
  normalizeCopilotModelOptionsWithCapabilities,
  normalizeCodexModelOptionsWithCapabilities,
  normalizeCursorModelOptionsWithCapabilities,
  normalizeDevinModelOptionsWithCapabilities,
  normalizeOpencodeModelOptionsWithCapabilities,
  normalizePiModelOptionsWithCapabilities,
  resolveEffort,
} from "@bigbud/shared/model";
import type { ReactNode } from "react";

import { getProviderModelCapabilities } from "../../../models/provider";
import { TraitsMenuContent, TraitsPicker } from "./TraitsPicker";
import { getProviderDescriptor } from "./providerDescriptors";

export type ComposerProviderStateInput = {
  provider: ProviderKind;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  prompt: string;
  modelOptions: ProviderModelOptions | null | undefined;
};

export type ComposerProviderState = {
  provider: ProviderKind;
  promptEffort: string | null;
  modelOptionsForDispatch: ProviderModelOptions[ProviderKind] | undefined;
  composerFrameClassName?: string;
  composerSurfaceClassName?: string;
  modelPickerIconClassName?: string;
};

type TraitRenderInput = {
  provider: ProviderKind;
  threadId: ThreadId;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ProviderModelOptions[ProviderKind] | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
};

function getProviderOptions(
  provider: ProviderKind,
  modelOptions: ProviderModelOptions | null | undefined,
): ProviderModelOptions[ProviderKind] | undefined {
  return modelOptions?.[provider];
}

function normalizeProviderOptions(
  input: ComposerProviderStateInput,
): ProviderModelOptions[ProviderKind] | undefined {
  const caps = getProviderModelCapabilities(input.models, input.model, input.provider);
  switch (input.provider) {
    case "codex":
      return normalizeCodexModelOptionsWithCapabilities(caps, input.modelOptions?.codex);
    case "claudeAgent":
      return normalizeClaudeModelOptionsWithCapabilities(caps, input.modelOptions?.claudeAgent);
    case "cursor":
      return normalizeCursorModelOptionsWithCapabilities(caps, input.modelOptions?.cursor);
    case "devin":
      return normalizeDevinModelOptionsWithCapabilities(caps, input.modelOptions?.devin);
    case "opencode":
      return normalizeOpencodeModelOptionsWithCapabilities(caps, input.modelOptions?.opencode);
    case "kilocode":
      return normalizeOpencodeModelOptionsWithCapabilities(caps, input.modelOptions?.kilocode);
    case "pi":
      return normalizePiModelOptionsWithCapabilities(caps, input.modelOptions?.pi);
    case "cliProxy":
      return input.modelOptions?.cliProxy;
    case "copilot":
      return normalizeCopilotModelOptionsWithCapabilities(caps, input.modelOptions?.copilot);
  }
}

export function getComposerProviderState(input: ComposerProviderStateInput): ComposerProviderState {
  const caps = getProviderModelCapabilities(input.models, input.model, input.provider);
  const providerOptions = getProviderOptions(input.provider, input.modelOptions);
  const rawEffort = providerOptions
    ? "effort" in providerOptions
      ? providerOptions.effort
      : "reasoningEffort" in providerOptions
        ? providerOptions.reasoningEffort
        : null
    : null;
  const ultrathinkActive =
    caps.promptInjectedEffortLevels.length > 0 && isClaudeUltrathinkPrompt(input.prompt);

  return {
    provider: input.provider,
    promptEffort: resolveEffort(caps, rawEffort) ?? null,
    modelOptionsForDispatch: normalizeProviderOptions(input),
    ...(ultrathinkActive ? { composerFrameClassName: "ultrathink-frame" } : {}),
    ...(ultrathinkActive
      ? { composerSurfaceClassName: "shadow-[0_0_0_1px_rgba(255,255,255,0.04)_inset]" }
      : {}),
    ...(ultrathinkActive ? { modelPickerIconClassName: "ultrathink-chroma" } : {}),
  };
}

export function renderProviderTraitsMenuContent(input: TraitRenderInput): ReactNode {
  if (!getProviderDescriptor(input.provider).traitsEnabled) return null;
  return (
    <TraitsMenuContent
      provider={input.provider}
      models={input.models}
      threadId={input.threadId}
      model={input.model}
      modelOptions={input.modelOptions}
      prompt={input.prompt}
      onPromptChange={input.onPromptChange}
    />
  );
}

export function renderProviderTraitsPicker(input: TraitRenderInput): ReactNode {
  if (!getProviderDescriptor(input.provider).traitsEnabled) return null;
  return (
    <TraitsPicker
      provider={input.provider}
      models={input.models}
      threadId={input.threadId}
      model={input.model}
      modelOptions={input.modelOptions}
      prompt={input.prompt}
      onPromptChange={input.onPromptChange}
    />
  );
}
