/**
 * Reasoning effort levels available for Codex and Copilot models.
 *
 * Higher effort levels use more compute for better quality responses
 * but may take longer to generate.
 *
 * - `xhigh`: Maximum reasoning effort
 * - `high`: High reasoning effort
 * - `medium`: Balanced effort (recommended for most use cases)
 * - `low`: Fast responses with minimal reasoning
 */
export const CODEX_REASONING_EFFORT_OPTIONS = ["xhigh", "high", "medium", "low"] as const;

/**
 * Code effort levels available for Claude models.
 *
 * - `ultrathink`: Maximum thinking time for complex problems
 * - `max`: Extended thinking for difficult tasks
 * - `high`: Thorough analysis
 * - `medium`: Balanced effort (recommended)
 * - `low`: Quick responses
 */
export const CLAUDE_CODE_EFFORT_OPTIONS = ["low", "medium", "high", "max", "ultrathink"] as const;

/**
 * Default model for each provider.
 *
 * These are used when:
 * - Creating a new thread without a model preference
 * - A provider is enabled but no model is selected
 * - Resetting to defaults
 */
export const DEFAULT_MODEL_BY_PROVIDER = {
  codex: "gpt-5.4",
  claudeAgent: "claude-sonnet-4-6",
  copilot: "gpt-5",
  opencode: "claude-sonnet-4-6",
  pi: "claude-sonnet-4.6",
  cursor: "claude-sonnet-4-5",
} as const;

/**
 * Default models for git text generation (commit messages, PR descriptions, etc.).
 *
 * These are typically smaller/faster models since git operations don't require
 * the full reasoning capabilities of the main models.
 */
export const DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER = {
  codex: "gpt-5.4-mini",
  claudeAgent: "claude-haiku-4-5",
  copilot: "gpt-5-mini",
  opencode: "claude-haiku-4-5",
  pi: "claude-haiku-4.5",
  cursor: "claude-haiku-4-5",
} as const;

/**
 * Model slug aliases for user convenience.
 *
 * Allows users to type shorter versions of model names.
 * For example, "5.4" maps to "gpt-5.4" for Codex.
 */
export const MODEL_SLUG_ALIASES_BY_PROVIDER = {
  codex: {
    "5.4": "gpt-5.4",
    "5.3": "gpt-5.3-codex",
    "gpt-5.3": "gpt-5.3-codex",
    "5.3-spark": "gpt-5.3-codex-spark",
    "gpt-5.3-spark": "gpt-5.3-codex-spark",
  },
  claudeAgent: {
    opus: "claude-opus-4-6",
    "opus-4.6": "claude-opus-4-6",
    "claude-opus-4.6": "claude-opus-4-6",
    "claude-opus-4-6-20251117": "claude-opus-4-6",
    sonnet: "claude-sonnet-4-6",
    "sonnet-4.6": "claude-sonnet-4-6",
    "claude-sonnet-4.6": "claude-sonnet-4-6",
    "claude-sonnet-4-6-20251117": "claude-sonnet-4-6",
    haiku: "claude-haiku-4-5",
    "haiku-4.5": "claude-haiku-4-5",
    "claude-haiku-4.5": "claude-haiku-4-5",
    "claude-haiku-4-5-20251001": "claude-haiku-4-5",
  },
  copilot: {
    "gpt-5.4": "gpt-5",
    "gpt-5.4-mini": "gpt-5-mini",
    "gpt-5.3": "gpt-5",
    "gpt-5.3-codex": "gpt-5",
    "gpt-5.3-codex-spark": "gpt-5-mini",
  },
  opencode: {},
  pi: {},
  cursor: {},
} as const;
