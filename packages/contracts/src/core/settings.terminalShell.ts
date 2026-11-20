import * as Schema from "effect/Schema";
import { ShellHostId, ShellSelection } from "../workspace/terminalShell";

export const TerminalShellSuggestionPolicy = Schema.Literals(["off", "qualified-history"]);
export type TerminalShellSuggestionPolicy = typeof TerminalShellSuggestionPolicy.Type;

const HostDefaults = Schema.Record(ShellHostId, ShellSelection).check(Schema.isMaxProperties(128));

/** Version zero is uninitialized, never evidence that an installation is fresh. */
export const TerminalShellSettings = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(0),
    origin: Schema.Literal("uninitialized"),
    hostDefaults: HostDefaults,
    suggestionPolicy: TerminalShellSuggestionPolicy,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    origin: Schema.Literals(["fresh", "existing-or-uncertain", "explicit"]),
    hostDefaults: HostDefaults,
    suggestionPolicy: TerminalShellSuggestionPolicy,
  }),
]);
export type TerminalShellSettings = typeof TerminalShellSettings.Type;

/** Defaults/policy change atomically; clients cannot forge/reset migration evidence. */
export const TerminalShellSettingsPatch = Schema.Struct({
  /** Atomic local-only change; other host choices are retained by the server. */
  localDefault: Schema.optionalKey(ShellSelection),
  hostDefaults: Schema.optionalKey(HostDefaults),
  suggestionPolicy: Schema.optionalKey(TerminalShellSuggestionPolicy),
});

export const DEFAULT_TERMINAL_SHELL_SETTINGS: TerminalShellSettings = {
  version: 0,
  origin: "uninitialized",
  hostDefaults: {},
  suggestionPolicy: "off",
};
