import {
  type ModelSelection,
  type ProviderKind,
  type ProviderModelOptions,
} from "@bigbud/contracts";

export function getProviderModelOptions(
  provider: "codex",
  options: ProviderModelOptions | null | undefined,
): ProviderModelOptions["codex"] | undefined;
export function getProviderModelOptions(
  provider: "claudeAgent",
  options: ProviderModelOptions | null | undefined,
): ProviderModelOptions["claudeAgent"] | undefined;
export function getProviderModelOptions(
  provider: "copilot",
  options: ProviderModelOptions | null | undefined,
): ProviderModelOptions["copilot"] | undefined;
export function getProviderModelOptions(
  provider: "opencode",
  options: ProviderModelOptions | null | undefined,
): ProviderModelOptions["opencode"] | undefined;
export function getProviderModelOptions(
  provider: "cursor",
  options: ProviderModelOptions | null | undefined,
): ProviderModelOptions["cursor"] | undefined;
export function getProviderModelOptions(
  provider: "pi",
  options: ProviderModelOptions | null | undefined,
): ProviderModelOptions["pi"] | undefined;
export function getProviderModelOptions(
  provider: ProviderKind,
  options: ProviderModelOptions | null | undefined,
): ProviderModelOptions[ProviderKind] | undefined;
export function getProviderModelOptions(
  provider: ProviderKind,
  options: ProviderModelOptions | null | undefined,
): ProviderModelOptions[ProviderKind] | undefined {
  switch (provider) {
    case "codex":
      return options?.codex;
    case "claudeAgent":
      return options?.claudeAgent;
    case "copilot":
      return options?.copilot;
    case "opencode":
      return options?.opencode;
    case "cursor":
      return options?.cursor;
    case "pi":
      return options?.pi;
  }
}

export function createModelSelection(
  provider: "codex",
  model: string,
  options?: ProviderModelOptions["codex"],
): Extract<ModelSelection, { provider: "codex" }>;
export function createModelSelection(
  provider: "claudeAgent",
  model: string,
  options?: ProviderModelOptions["claudeAgent"],
): Extract<ModelSelection, { provider: "claudeAgent" }>;
export function createModelSelection(
  provider: "copilot",
  model: string,
  options?: ProviderModelOptions["copilot"],
): Extract<ModelSelection, { provider: "copilot" }>;
export function createModelSelection(
  provider: "opencode",
  model: string,
  options?: ProviderModelOptions["opencode"],
): Extract<ModelSelection, { provider: "opencode" }>;
export function createModelSelection(
  provider: "pi",
  model: string,
  options?: ProviderModelOptions["pi"],
): Extract<ModelSelection, { provider: "pi" }>;
export function createModelSelection(
  provider: ProviderKind,
  model: string,
  options?: ProviderModelOptions[ProviderKind],
): ModelSelection;
export function createModelSelection(
  provider: ProviderKind,
  model: string,
  options?: ProviderModelOptions[ProviderKind],
): ModelSelection {
  switch (provider) {
    case "codex": {
      const codexOptions = options as ProviderModelOptions["codex"] | undefined;
      return codexOptions ? { provider, model, options: codexOptions } : { provider, model };
    }
    case "claudeAgent": {
      const claudeOptions = options as ProviderModelOptions["claudeAgent"] | undefined;
      return claudeOptions ? { provider, model, options: claudeOptions } : { provider, model };
    }
    case "copilot": {
      const copilotOptions = options as ProviderModelOptions["copilot"] | undefined;
      return copilotOptions ? { provider, model, options: copilotOptions } : { provider, model };
    }
    case "opencode": {
      const opencodeOptions = options as ProviderModelOptions["opencode"] | undefined;
      return opencodeOptions ? { provider, model, options: opencodeOptions } : { provider, model };
    }
    case "pi": {
      const piOptions = options as ProviderModelOptions["pi"] | undefined;
      return piOptions ? { provider, model, options: piOptions } : { provider, model };
    }
    case "cursor": {
      const cursorOptions = options as ProviderModelOptions["cursor"] | undefined;
      return cursorOptions ? { provider, model, options: cursorOptions } : { provider, model };
    }
  }
}

export function cloneModelSelection<T extends ModelSelection>(
  selection: T,
  overrides?: Partial<T>,
): T {
  return {
    ...selection,
    ...overrides,
  };
}
