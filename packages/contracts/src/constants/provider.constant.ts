/**
 * All available provider kinds in the bigbud application.
 *
 * Providers represent different AI coding assistant backends that can be used
 * for code generation, chat, and other AI-powered features.
 *
 * Provider display order is derived alphabetically by name.
 */
const UNSORTED_PROVIDER_KINDS = [
  "codex",
  "claudeAgent",
  "cliProxy",
  "copilot",
  "cursor",
  "devin",
  "kilocode",
  "opencode",
  "pi",
] as const;

export const PROVIDER_DISPLAY_NAMES = {
  codex: "Codex",
  claudeAgent: "Claude",
  cliProxy: "CLIProxyAPI",
  copilot: "Copilot",
  kilocode: "KiloCode",
  opencode: "OpenCode",
  pi: "Pi",
  cursor: "Cursor",
  devin: "Devin",
  bigbud: "bigbud",
} as const;

type ProviderKind = (typeof UNSORTED_PROVIDER_KINDS)[number];

/** Returns provider kinds alphabetized by their display names. */
export function sortProviderKindsByDisplayName<T extends readonly ProviderKind[]>(
  providerKinds: T,
): T {
  // Sorting preserves the tuple's entries and length, which TypeScript cannot infer.
  return providerKinds.toSorted((left, right) =>
    PROVIDER_DISPLAY_NAMES[left].localeCompare(PROVIDER_DISPLAY_NAMES[right]),
  ) as unknown as T;
}

export const PROVIDER_KINDS = sortProviderKindsByDisplayName(UNSORTED_PROVIDER_KINDS);

/**
 * Labels that may appear in the `provider` field of a `ServerDiscoveredSkill`
 * or `ServerDiscoveredAgent`. Extends `PROVIDER_KINDS` with `bigbud`, the
 * pseudo-label used for skills discovered under `.bigbud/skills/` — a directory
 * the bigbud app itself ships with (or that the user adds to a bigbud project).
 *
 * The runtime provider system (model selection, capabilities, adapters) only
 * uses `PROVIDER_KINDS`; `bigbud` is purely a discovery label that has no
 * associated AI runtime.
 */
export const SERVER_DISCOVERY_PROVIDER_LABELS = [...PROVIDER_KINDS, "bigbud"] as const;

/**
 * Default provider used when no preference is set.
 */
export const DEFAULT_PROVIDER_KIND = "codex" as const;
