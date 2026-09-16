import {
  DEFAULT_MODEL_BY_PROVIDER,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  type ModelSelection,
  type ProviderKind,
} from "@bigbud/contracts";

export interface SelectableModelOption {
  slug: string;
  name: string;
}

export {
  formatEffortLabel,
  getDefaultEffort,
  getEffortMetadataStatus,
  hasEffortLevel,
  isAuthoritativeEffortMetadata,
  resolveEffort,
  sanitizeEffortOptions,
  withEffortProvenance,
} from "./model.effort";
export {
  buildNextProviderOptions,
  getProviderEffortField,
  getRawProviderEffort,
  patchProviderEffort,
} from "./model.effortFields";
export {
  getDefaultContextWindow,
  hasContextWindowOption,
  resolveContextWindow,
} from "./model.context";
export {
  normalizeClaudeModelOptionsWithCapabilities,
  normalizeCodexModelOptionsWithCapabilities,
  normalizeCopilotModelOptionsWithCapabilities,
  normalizeCursorModelOptionsWithCapabilities,
  normalizeDevinModelOptionsWithCapabilities,
  normalizeKilocodeModelOptionsWithCapabilities,
  normalizeOpencodeModelOptionsWithCapabilities,
  normalizePiModelOptionsWithCapabilities,
} from "./model.normalize";
export { trimOrNull } from "./model.strings";

export function isClaudeUltrathinkPrompt(text: string | null | undefined): boolean {
  return typeof text === "string" && /\bultrathink\b/i.test(text);
}

export function normalizeModelSlug(
  model: string | null | undefined,
  provider: ProviderKind = "codex",
): string | null {
  if (typeof model !== "string") {
    return null;
  }

  const trimmed = model.trim();
  if (!trimmed) {
    return null;
  }

  const aliases = MODEL_SLUG_ALIASES_BY_PROVIDER[provider] as Record<string, string>;
  const aliased = Object.prototype.hasOwnProperty.call(aliases, trimmed)
    ? aliases[trimmed]
    : undefined;
  return typeof aliased === "string" ? aliased : trimmed;
}

export function resolveSelectableModel(
  provider: ProviderKind,
  value: string | null | undefined,
  options: ReadonlyArray<SelectableModelOption>,
): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const direct = options.find((option) => option.slug === trimmed);
  if (direct) {
    return direct.slug;
  }

  const byName = options.find((option) => option.name.toLowerCase() === trimmed.toLowerCase());
  if (byName) {
    return byName.slug;
  }

  const normalized = normalizeModelSlug(trimmed, provider);
  if (!normalized) {
    return null;
  }

  const resolved = options.find((option) => option.slug === normalized);
  return resolved ? resolved.slug : null;
}

export function resolveModelSlug(model: string | null | undefined, provider: ProviderKind): string {
  const normalized = normalizeModelSlug(model, provider);
  if (!normalized) {
    return DEFAULT_MODEL_BY_PROVIDER[provider];
  }
  return normalized;
}

export function resolveModelSlugForProvider(
  provider: ProviderKind,
  model: string | null | undefined,
): string {
  return resolveModelSlug(model, provider);
}

/**
 * Resolve the actual API model identifier from a model selection.
 *
 * Provider-aware: each provider can map `contextWindow` (or other options)
 * to whatever the API requires — a model-id suffix, a separate parameter, etc.
 * The canonical slug stored in the selection stays unchanged so the
 * capabilities system keeps working.
 *
 * Expects `contextWindow` to already be resolved (via `resolveContextWindow`)
 * to the effective value, not stripped to `undefined` for defaults.
 */
export function resolveApiModelId(modelSelection: ModelSelection): string {
  switch (modelSelection.provider) {
    case "claudeAgent": {
      switch (modelSelection.options?.contextWindow) {
        case "1m":
          return `${modelSelection.model}[1m]`;
        default:
          return modelSelection.model;
      }
    }
    default: {
      return modelSelection.model;
    }
  }
}

export function applyClaudePromptEffortPrefix(
  text: string,
  effort: string | null | undefined,
): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (effort !== "ultrathink") {
    return trimmed;
  }
  if (trimmed.startsWith("Ultrathink:")) {
    return trimmed;
  }
  return `Ultrathink:\n${trimmed}`;
}
