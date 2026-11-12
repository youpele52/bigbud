import type {
  ShellSelection,
  TerminalShellProfile,
} from "@bigbud/contracts/workspace/terminalShell.ts";
import * as Effect from "effect/Effect";
import { FRESH_WINDOWS_SHELL_DEFAULTS_QUALIFIED } from "../../constants/terminalShells";
import { LOCAL_SHELL_HOST, shellExecutableIdentity } from "./ShellProfiles.identity";
import { probeLocalShellProfiles } from "./ShellProfiles.local";

const rank = (kind: TerminalShellProfile["kind"]): number => {
  switch (kind) {
    case "pwsh":
      return 0;
    case "windows-powershell":
      return 1;
    case "cmd":
      return 2;
    default:
      return 3;
  }
};

/** Inventory is produced by the trusted host probe, not supplied by a settings client.
 * A concrete stable ID is persisted once; installing a better shell later cannot rerank it.
 */
export function selectFreshWindowsShellProfile(
  profiles: readonly TerminalShellProfile[],
): ShellSelection | undefined {
  const eligible = profiles.filter(
    (profile) =>
      profile.host.kind === "local" &&
      profile.host.hostId === LOCAL_SHELL_HOST.hostId &&
      profile.platform === "win32" &&
      profile.availability === "available" &&
      rank(profile.kind) < 3,
  );
  eligible.sort((left, right) => {
    const priority = rank(left.kind) - rank(right.kind);
    if (priority !== 0) return priority;
    // Avoid locale-dependent ordering and input-order-dependent persisted choices.
    const a = shellExecutableIdentity(left.executable, "win32");
    const b = shellExecutableIdentity(right.executable, "win32");
    return a < b
      ? -1
      : a > b
        ? 1
        : left.profileId < right.profileId
          ? -1
          : left.profileId > right.profileId
            ? 1
            : 0;
  });
  const selected = eligible[0];
  return selected ? { kind: "profile", profileId: selected.profileId } : undefined;
}

/** The production gate is deliberately closed. No executable probe occurs while closed.
 * Injectable inventory/gate support focused composition tests, not a runtime enable API.
 */
export function discoverFreshWindowsShellSelection<E, R>(
  inventory: Effect.Effect<readonly TerminalShellProfile[], E, R>,
  qualified: boolean = FRESH_WINDOWS_SHELL_DEFAULTS_QUALIFIED,
): Effect.Effect<ShellSelection | undefined, E, R> {
  return qualified
    ? inventory.pipe(Effect.map(selectFreshWindowsShellProfile))
    : Effect.succeed(undefined);
}

export const productionFreshWindowsShellSelection = discoverFreshWindowsShellSelection(
  probeLocalShellProfiles({ platform: "win32" }),
);
