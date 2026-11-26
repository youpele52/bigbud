import { createHash } from "node:crypto";
import path from "node:path";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  TerminalShellProfile,
  type ShellHostScope,
  type ShellSelection,
} from "@bigbud/contracts/workspace/terminalShell.ts";

import { withProductionTerminalOwner } from "../../ssh/sshOwnerProductionTerminal.ts";
import type { SshOwnerProductionRegistration } from "../../ssh/sshOwnerProductionRegistry.ts";
import {
  ShellProfileDiscoveryError,
  type ShellProfileInventory,
  type ShellProfileTarget,
} from "../Services/ShellProfiles.ts";
import type { PtySpawnInput } from "../Services/PTY.ts";
import { shellKind, shellProfileId } from "./ShellProfiles.identity.ts";
import {
  ShellProfileResolutionError,
  type ResolvedShellProfileLaunch,
} from "./ShellProfiles.launch.ts";

/**
 * U16 production shell profiles for direct SSH targets: the inventory is the
 * owner's typed `list_terminal_shells` (the target's own `/etc/shells`), and a
 * selected profile launches by sending only that listed path; the owner
 * re-checks it against `/etc/shells` at launch. Profiles carry no extra argv.
 *
 * @module ShellProfiles.sshOwner
 */

const PLATFORM = "other" as const;
const MAX_CACHE = 256;

export function makeProductionShellProfiles(
  read: () => SshOwnerProductionRegistration | undefined,
) {
  // profileId → owner-listed path, from the latest inventory of its target.
  const listed = new Map<string, string>();
  const hostFor = (targetId: string): ShellHostScope => ({
    kind: "ssh",
    hostId: createHash("sha256")
      .update(JSON.stringify(["ssh-owner", targetId]))
      .digest("hex"),
  });
  const profileFor = (host: ShellHostScope, executable: string) =>
    Schema.decodeUnknownSync(TerminalShellProfile)({
      profileId: shellProfileId(host, executable, [], PLATFORM),
      host,
      kind: shellKind(executable, "linux"),
      displayName: path.posix.basename(executable),
      executable,
      args: [],
      platform: PLATFORM,
      availability: "available",
      integration: { status: "unavailable", reason: "not-qualified" },
    });

  const list = Effect.fn("productionShellProfiles.list")(function* (target: ShellProfileTarget) {
    const host = hostFor(target.executionTargetId);
    const shells = yield* Effect.tryPromise({
      try: () =>
        withProductionTerminalOwner(read, target.executionTargetId, (owner) =>
          owner.listTerminalShells(),
        ),
      catch: () => new ShellProfileDiscoveryError({ reason: "probe-failed" }),
    });
    const profiles = shells.map((executable) => profileFor(host, executable));
    if (listed.size > MAX_CACHE) listed.clear();
    for (const profile of profiles) listed.set(profile.profileId, profile.executable);
    return { host, profiles } satisfies ShellProfileInventory;
  });

  const resolve = Effect.fn("productionShellProfiles.resolve")(function* (
    selection: ShellSelection,
    target: ShellProfileTarget,
  ) {
    // `legacy-auto` keeps the account's own login shell.
    if (selection.kind !== "profile") return null;
    const inventory = yield* list(target);
    const profile = inventory.profiles.find((entry) => entry.profileId === selection.profileId);
    if (!profile) return yield* new ShellProfileResolutionError({ reason: "missing-profile" });
    return {
      shell: profile.executable,
      args: [],
      platform: profile.platform,
      dropPathMode: "posix",
      identity: {
        host: inventory.host,
        selection,
        profileId: profile.profileId,
        kind: profile.kind,
        integration: profile.integration,
      },
    } satisfies ResolvedShellProfileLaunch;
  });

  /** The listed path for a spawn's selected profile; `undefined` refuses it. */
  const shellFor = (input: PtySpawnInput): string | undefined => {
    const profileId = input.shellProfile?.profileId;
    return profileId ? listed.get(profileId) : undefined;
  };

  return { list, resolve, shellFor };
}
