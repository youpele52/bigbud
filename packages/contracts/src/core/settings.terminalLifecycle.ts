import { Schema } from "effect";

/**
 * Server-owned: the server decides at quit whether host terminals keep running. Off by default,
 * so quitting bigbud closes its terminals as it does today.
 */
export const TerminalLifecycleSettingsFields = {
  terminalsKeepRunningAfterQuit: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  /** Runs new local terminals in the background terminal host. Read at startup; applies after a restart. */
  terminalHostEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
};

export const TerminalLifecycleSettingsPatchFields = {
  terminalsKeepRunningAfterQuit: Schema.optionalKey(Schema.Boolean),
  terminalHostEnabled: Schema.optionalKey(Schema.Boolean),
};
