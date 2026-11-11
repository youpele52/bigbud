import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "../core/baseSchemas";
import { ShellHostScope, TerminalShellProfile } from "./terminalShell";

/** Existing-pane lookup only: the server owns execution target and account identity. */
export const TerminalShellProfilesInput = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  terminalId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type TerminalShellProfilesInput = typeof TerminalShellProfilesInput.Type;

/** One complete execution-host inventory. Never merge local/remote results. */
export const TerminalShellProfileInventory = Schema.Struct({
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
