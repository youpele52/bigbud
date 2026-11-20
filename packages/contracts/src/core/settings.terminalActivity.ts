import { Schema } from "effect";

/** Server-owned: pane shells are spawned by the server, which reads this at launch. */
export const TerminalActivitySettingsFields = {
  /** Inject completion hooks for terminal agents (Claude Code, Codex) inside bigbud panes. */
  terminalAgentHooksEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
};

export const TerminalActivitySettingsPatchFields = {
  terminalAgentHooksEnabled: Schema.optionalKey(Schema.Boolean),
};
