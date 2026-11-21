import { Schema } from "effect";

/**
 * Server-owned: the server decides at quit whether host terminals keep running. Off by default,
 * so quitting bigbud closes its terminals as it does today.
 */
export const TerminalLifecycleSettingsFields = {
  terminalsKeepRunningAfterQuit: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
};

export const TerminalLifecycleSettingsPatchFields = {
  terminalsKeepRunningAfterQuit: Schema.optionalKey(Schema.Boolean),
};
