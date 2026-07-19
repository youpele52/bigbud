/**
 * All available provider kinds in the bigbud application.
 *
 * Providers represent different AI coding assistant backends that can be used
 * for code generation, chat, and other AI-powered features.
 *
 * Order matters for fallback logic in some contexts.
 */
export const PROVIDER_KINDS = [
  "codex",
  "claudeAgent",
  "copilot",
  "kilocode",
  "opencode",
  "pi",
  "cursor",
  "devin",
  "cliProxy",
] as const;

export const PROVIDER_DISPLAY_NAMES = {
  codex: "Codex",
  claudeAgent: "Claude",
  copilot: "Copilot",
  kilocode: "KiloCode",
  opencode: "OpenCode",
  pi: "Pi",
  cursor: "Cursor",
  devin: "Devin",
  cliProxy: "CLIProxy (experimental)",
  bigbud: "bigbud",
} as const;

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
