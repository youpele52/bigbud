import { Schema } from "effect";

/**
 * How far bigbud may reach on this computer. The File Access section edits it; the server mirror
 * (`search.fileAccessLevel`) is what the server enforces for "Search this computer" (plan Q2).
 */
export const FileAccessPermissionLevel = Schema.Literals([
  "none",
  "common-folders",
  "unrestricted",
] as const);
export type FileAccessPermissionLevel = typeof FileAccessPermissionLevel.Type;

/** Server-enforced Mod+F and Mod+P search options (system-wide search plan §6). */
export const SearchSettings = Schema.Struct({
  /**
   * "Search this computer" through the OS index. On by default (plan Q1, revised 20 November
   * 2026); File Access stays the gate, so `fileAccessLevel: "none"` still keeps it off.
   */
  thisComputer: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  /** "Search connected remote backends": other projects on connected remotes (T4/T6). On. */
  connectedRemoteBackends: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  /** Server mirror of the File Access level; `none` turns "this computer" off. */
  fileAccessLevel: FileAccessPermissionLevel.pipe(
    Schema.withDecodingDefault(() => "none" as const satisfies FileAccessPermissionLevel),
  ),
  /** The one-time "Search this computer" hint was shown or dismissed. */
  hasSeenThisComputerHint: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
});
export type SearchSettings = typeof SearchSettings.Type;

export const SearchSettingsFields = {
  search: SearchSettings.pipe(Schema.withDecodingDefault(() => ({}))),
};

export const SearchSettingsPatchFields = {
  search: Schema.optionalKey(
    Schema.Struct({
      thisComputer: Schema.optionalKey(Schema.Boolean),
      connectedRemoteBackends: Schema.optionalKey(Schema.Boolean),
      fileAccessLevel: Schema.optionalKey(FileAccessPermissionLevel),
      hasSeenThisComputerHint: Schema.optionalKey(Schema.Boolean),
    }),
  ),
};
