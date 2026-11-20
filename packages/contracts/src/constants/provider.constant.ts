/**
 * All persisted provider kinds, including retired history IDs.
 *
 * New runtime choices use SELECTABLE_PROVIDER_KINDS and still require
 * provider readiness and feature admission.
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
  "muse",
  "opencode",
  "opencodeV2",
  "pi",
] as const;

export const PROVIDER_DISPLAY_NAMES = {
  codex: "Codex",
  claudeAgent: "Claude",
  cliProxy: "CLIProxyAPI",
  copilot: "Copilot",
  opencode: "OpenCode",
  opencodeV2: "OpenCode",
  pi: "Pi",
  cursor: "Cursor",
  devin: "Devin",
  muse: "Muse Code",
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

/** Historical decoding set: retired IDs must remain readable in persisted records. */
export const PROVIDER_KINDS = sortProviderKindsByDisplayName(UNSORTED_PROVIDER_KINDS);

/** New runtime selections; this does not waive provider readiness or preview restrictions. */
export const SELECTABLE_PROVIDER_KINDS: ReadonlyArray<Exclude<ProviderKind, "opencode">> =
  PROVIDER_KINDS.filter((provider) => provider !== "opencode");

/**
 * Labels that may appear in the `provider` field of a `ServerDiscoveredSkill`
 * or `ServerDiscoveredAgent`. Extends `PROVIDER_KINDS` with `bigbud`, the
 * pseudo-label used for skills discovered under `.bigbud/skills/` — a directory
 * the bigbud app itself ships with (or that the user adds to a bigbud project).
 *
 * Discovery labels do not imply selectable runtime support. `bigbud` is
 * purely a discovery label with no associated AI runtime.
 */
export const SERVER_DISCOVERY_PROVIDER_LABELS = [...PROVIDER_KINDS, "bigbud"] as const;

/**
 * Default provider used when no preference is set.
 */
export const DEFAULT_PROVIDER_KIND = "codex" as const;
