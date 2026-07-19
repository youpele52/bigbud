import { type ProviderKind } from "@bigbud/contracts";
import { type ProviderPickerKind, PROVIDER_OPTIONS } from "../../../logic/session";
import {
  ClaudeAI,
  CopilotIcon,
  CursorIcon,
  DevinIcon,
  type Icon,
  KilocodeIcon,
  OpenAI,
  OpenCodeIcon,
  PiIcon,
} from "../../Icons";

export function isAvailableProviderOption(option: (typeof PROVIDER_OPTIONS)[number]): option is {
  value: ProviderKind;
  label: string;
  available: true;
} {
  return option.available;
}

export const PROVIDER_ICON_BY_PROVIDER: Record<ProviderPickerKind, Icon> = {
  codex: OpenAI,
  claudeAgent: ClaudeAI,
  cliProxy: ClaudeAI,
  copilot: CopilotIcon,
  opencode: OpenCodeIcon,
  kilocode: KilocodeIcon,
  pi: PiIcon,
  cursor: CursorIcon,
  devin: DevinIcon,
};

export const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(isAvailableProviderOption);
export const UNAVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter((option) => !option.available);
export type { ProviderPickerKind } from "../../../logic/session";

// exactOptionalPropertyTypes: group/subProviderID must be `string | undefined` so callers can
// safely pass through server model mappings unchanged.
export type ModelOption = {
  slug: string;
  name: string;
  group?: string | undefined;
  subProviderID?: string | undefined;
};

/**
 * Converts a model slug like "gemini-3-flash-preview" to a human-readable name "Gemini 3 Flash Preview".
 * Used as a fallback when model options aren't loaded yet.
 */
export function formatSlugAsDisplayName(slug: string): string {
  return slug
    .split("-")
    .map((word) => {
      if (/^\d+(\.\d+)*$/.test(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

export function providerIconClassName(
  _provider: ProviderKind | ProviderPickerKind,
  fallbackClassName: string,
): string {
  return fallbackClassName;
}

export function modelOptionValue(option: ModelOption): string {
  return option.subProviderID ? `${option.slug}::${option.subProviderID}` : option.slug;
}

export function providerSupportsSubProviderID(provider: ProviderKind): boolean {
  return (
    provider === "opencode" ||
    provider === "kilocode" ||
    provider === "pi" ||
    provider === "cliProxy"
  );
}

export function visibleModelOptionsForPicker(
  provider: ProviderKind,
  options: ReadonlyArray<ModelOption>,
  recentOptions: ReadonlyArray<ModelOption> | undefined,
  query: string,
): ReadonlyArray<ModelOption> {
  if (query.trim() || !recentOptions?.length || providerSupportsSubProviderID(provider)) {
    return options;
  }

  const recentValues = new Set(recentOptions.map(modelOptionValue));
  return options.filter((option) => !recentValues.has(modelOptionValue(option)));
}

type GroupedSection =
  | { kind: "named"; group: string; models: ModelOption[] }
  | { kind: "ungrouped"; models: ModelOption[] };

export function groupModelOptions(options: ReadonlyArray<ModelOption>): GroupedSection[] {
  const namedMap = new Map<string, ModelOption[]>();
  const ungrouped: ModelOption[] = [];
  for (const option of options) {
    if (option.group) {
      if (!namedMap.has(option.group)) namedMap.set(option.group, []);
      namedMap.get(option.group)?.push(option);
      continue;
    }
    ungrouped.push(option);
  }

  const named: GroupedSection[] = [...namedMap.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([group, models]) => ({ kind: "named" as const, group, models }));
  if (ungrouped.length > 0) {
    named.push({ kind: "ungrouped" as const, models: ungrouped });
  }
  return named;
}
