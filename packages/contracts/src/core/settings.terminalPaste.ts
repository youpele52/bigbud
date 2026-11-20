import { Schema } from "effect";

/** Per-file cap for pasted or dropped files staged on a terminal's machine, in MB. */
export const TERMINAL_PASTE_MAX_FILE_MB = { default: 20, min: 10, max: 200 } as const;

const TerminalPasteMaxFileMb = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(TERMINAL_PASTE_MAX_FILE_MB.min),
).check(Schema.isLessThanOrEqualTo(TERMINAL_PASTE_MAX_FILE_MB.max));

/** Server-owned: the server enforces the staging cap for every client, including phones. */
export const TerminalPasteSettingsFields = {
  terminalPasteMaxFileMb: TerminalPasteMaxFileMb.pipe(
    Schema.withDecodingDefault(() => TERMINAL_PASTE_MAX_FILE_MB.default),
  ),
  /** Answer kitty/Ghostty OSC 5522 clipboard reads for the pane the user is pasting into. */
  terminalClipboardRequests: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
};

export const TerminalPasteSettingsPatchFields = {
  terminalPasteMaxFileMb: Schema.optionalKey(TerminalPasteMaxFileMb),
  terminalClipboardRequests: Schema.optionalKey(Schema.Boolean),
};

export const terminalPasteMaxFileBytes = (megabytes: number): number => megabytes * 1024 * 1024;
