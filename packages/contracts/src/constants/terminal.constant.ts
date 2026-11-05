/**
 * Default terminal ID for the primary terminal in a thread.
 */
export const DEFAULT_TERMINAL_ID = "default";

/**
 * Default height (px) for thread-embedded terminals in the UI.
 */
export const DEFAULT_THREAD_TERMINAL_HEIGHT = 280;

/**
 * Maximum number of terminals allowed per terminal group.
 *
 * Prevents UI clutter and resource exhaustion.
 */
export const MAX_TERMINALS_PER_GROUP = 4;

/**
 * Terminal-only agent identity ids that get a terminal logo without being chat providers.
 *
 * The server stamps these ids on detected foreground programs; the web maps them to icons.
 */
export const TERMINAL_ONLY_AGENT_KINDS = ["herdr"] as const;
export type TerminalOnlyAgentKind = (typeof TERMINAL_ONLY_AGENT_KINDS)[number];
