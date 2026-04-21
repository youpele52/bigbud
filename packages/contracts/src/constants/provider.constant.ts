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
  "opencode",
  "pi",
  "cursor",
] as const;

/**
 * Human-readable display names for each provider.
 *
 * Used in UI components, settings panels, and user-facing messages.
 */
export const PROVIDER_DISPLAY_NAMES = {
  codex: "Codex",
  claudeAgent: "Claude",
  copilot: "Copilot",
  opencode: "OpenCode",
  pi: "Pi",
  cursor: "Cursor",
} as const;

/**
 * Default provider used when no preference is set.
 */
export const DEFAULT_PROVIDER_KIND = "codex" as const;
