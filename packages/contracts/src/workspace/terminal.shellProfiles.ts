import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "../core/baseSchemas";
import { ShellHostScope, TerminalShellProfile } from "./terminalShell";

/** Pane lookup or fixed server-local settings inventory; never client-selected target/account. */
export const TerminalShellProfilesInput = Schema.Union([
  Schema.Struct({
    threadId: TrimmedNonEmptyString,
    terminalId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  }),
  Schema.Struct({ scope: Schema.Literal("local-settings") }),
]);
export type TerminalShellProfilesInput = typeof TerminalShellProfilesInput.Type;

/** One complete execution-host inventory. Never merge local/remote results. */
export const TerminalShellProfileInventory = Schema.Struct({
  exactProfileLaunchesEnabled: Schema.optionalKey(Schema.Boolean),
  runtimeGeneration: Schema.optionalKey(TrimmedNonEmptyString),
  localDefaultsEnabled: Schema.optionalKey(Schema.Boolean),
  host: ShellHostScope,
  profiles: Schema.Array(TerminalShellProfile).check(Schema.isMaxLength(64)),
}).check(
  Schema.makeFilter(({ host, profiles }) => {
    const ids = new Set<string>();
    return profiles.every((profile) => {
      const matches =
        profile.host.kind === host.kind &&
        profile.host.hostId === host.hostId &&
        (host.kind !== "wsl" ||
          (profile.host.kind === "wsl" &&
            profile.host.distribution === host.distribution &&
            profile.host.username === host.username));
      if (!matches || ids.has(profile.profileId)) return false;
      ids.add(profile.profileId);
      return true;
    });
  }),
);
export type TerminalShellProfileInventory = typeof TerminalShellProfileInventory.Type;
