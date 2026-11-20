import {
  isRemoteAgentRemovalFenceId,
  REMOTE_AGENT_REMOVAL_FENCE_TTL_MS,
} from "./remoteAgentInstall.registry.removalFence.ts";
import { hasRemoteAgentPathControls } from "./remoteAgentRuntime.ts";
import { quoteShellArgument as quote } from "./remoteAgentShellQuote.ts";

/**
 * Removal deletes exactly `$HOME/.bigbud/agent` and nothing else: never `~/.bigbud/backend-*`,
 * `graph`, `workspace-modes` or user-managed binaries outside that tree. Under the inbox claim
 * lock and the registry lock the tree is atomically renamed to `~/.bigbud/.agent-removing.*`;
 * that directory's existence is the tombstone, and install and cleanup delete leftovers first.
 */
export const REMOTE_AGENT_REMOVING_PREFIX = ".agent-removing.";
/** Bounded wait for the install script or another controller to release a lock. */
const LOCK_WAIT_SECONDS = 10;

export type RemoteAgentRemovalCommandResult =
  | { readonly kind: "removed" }
  | { readonly kind: "none" }
  | { readonly kind: "busy"; readonly lock: "inbox" | "registry" | "socket" }
  | {
      readonly kind: "refused";
      readonly reason: "foreign-owner" | "mount" | "layout" | "fence";
    };

export type RemoteAgentRemovalCommandMode =
  | { readonly mode: "remove"; readonly fenceId: string }
  | { readonly mode: "resume" };

/**
 * Guards shared by both modes. Every check is a plain assignment or test, so a failing `find`,
 * `awk` or missing `/proc` file aborts under `set -e` instead of passing. Only POSIX `find`
 * options are used; mounts are read from `/proc/self/mountinfo`.
 */
const TREE_GUARD = `guard_tree() {
  tree="$1"
  test "$(stat -c '%u' -- "$tree")" = "$uid" || { printf refused:foreign-owner; exit 0; }
  # -prune: report a foreign directory without descending into it (unreadable to a non-root uid).
  foreign=$(find "$tree" ! -user "$uid" -print -prune)
  if test -n "$foreign"; then printf refused:foreign-owner; exit 0; fi
  mounts=$(awk -v r="$tree" '$5 == r || index($5, r "/") == 1 { print $5 }' /proc/self/mountinfo)
  if test -n "$mounts"; then printf refused:mount; exit 0; fi
}`;

function prelude(root: string): string {
  return `set -eu
umask 077
root=${quote(root)}
home=$(readlink -f -- "$HOME")
parent="$home/.bigbud"
test "$root" = "$parent/agent"
uid=$(id -u)
# GNU rm stays on one file system; BusyBox rm lacks the flag, and mounts are refused above anyway.
rm_flags=
if rm -rf --one-file-system -- "$parent/.bigbud-rm-probe-$$" 2>/dev/null; then rm_flags=--one-file-system; fi
${TREE_GUARD}`;
}

/**
 * The guards match paths textually (`/proc/net/unix`, `/proc/self/mountinfo` escapes spaces as
 * \\040), so a root containing whitespace or control characters is never removed automatically.
 */
export function isRemovableRemoteAgentRoot(root: string): boolean {
  return (
    root.startsWith("/") &&
    root.endsWith("/.bigbud/agent") &&
    !hasRemoteAgentPathControls(root) &&
    !/\s/.test(root)
  );
}

/** Deletes leftovers of an interrupted removal; never touches the live agent tree. */
function resumeScript(root: string): string {
  return `${prelude(root)}
cleaned=none
if test -d "$parent" && test ! -L "$parent"; then
  for leftover in "$parent"/${REMOTE_AGENT_REMOVING_PREFIX}*; do
    if test ! -e "$leftover" && test ! -L "$leftover"; then continue; fi
    if test -L "$leftover" || test ! -d "$leftover"; then printf refused:layout; exit 0; fi
    guard_tree "$leftover"
    rm -rf $rm_flags -- "$leftover"
    cleaned=removed
  done
fi
printf %s "$cleaned"
`;
}

function removeScript(root: string, fenceId: string): string {
  return `${prelude(root)}
fence=${quote(fenceId)}
if test ! -e "$root" && test ! -L "$root"; then printf removed; exit 0; fi
test -d "$parent"
test ! -L "$parent"
test -d "$root"
test ! -L "$root"
test "$(readlink -f -- "$root")" = "$root"
guard_tree "$root"
for dir in "$root/inbox" "$root/control-v1"; do
  if test -L "$dir" || { test -e "$dir" && test ! -d "$dir"; }; then printf refused:layout; exit 0; fi
  test -d "$dir" || mkdir -m 700 -- "$dir"
done
# The staging script holds the inbox claim lock and every controller the registry lock.
claim="$root/inbox/.claim.lock"
lock="$root/control-v1/registry.lock"
if test -L "$claim" || test -L "$lock"; then printf refused:layout; exit 0; fi
exec 8<> "$claim"
flock -w ${LOCK_WAIT_SECONDS} 8 || { printf busy:inbox; exit 0; }
exec 9<> "$lock"
flock -w ${LOCK_WAIT_SECONDS} 9 || { printf busy:registry; exit 0; }
registry="$root/control-v1/registry.json"
# The fence must still be ours and fresh by the host's clock (the store stamps it with that clock).
started=
if test -f "$registry"; then
  started=$(sed -n "s/.*\\"removal\\":{\\"id\\":\\"$fence\\",\\"controllerId\\":\\"[^\\"]*\\",\\"startedAt\\":\\([0-9]*\\)}.*/\\1/p" "$registry")
fi
if test -z "$started"; then printf refused:fence; exit 0; fi
age=$(( $(date +%s) - started / 1000 ))
if test "$age" -ge ${REMOTE_AGENT_REMOVAL_FENCE_TTL_MS / 1000} || test "$age" -lt -60; then printf refused:fence; exit 0; fi
# Any socket still bound under the tree means a process the registry may not know about.
sockets=$(awk -v r="$root/" 'NR > 1 && index($NF, r) == 1 { print $NF }' /proc/net/unix)
if test -n "$sockets"; then printf busy:socket; exit 0; fi
removing="$parent/${REMOTE_AGENT_REMOVING_PREFIX}$(date +%s).$$"
mv -- "$root" "$removing"
sync -f "$parent" 2>/dev/null || sync
rm -rf $rm_flags -- "$removing"
sync -f "$parent" 2>/dev/null || sync
test ! -e "$root"
test ! -L "$root"
printf removed
`;
}

export function buildRemoteAgentRemovalCommand(
  root: string,
  mode: RemoteAgentRemovalCommandMode,
): string {
  if (!isRemovableRemoteAgentRoot(root)) throw new Error("Invalid remote agent root.");
  if (mode.mode === "resume") return resumeScript(root);
  if (!isRemoteAgentRemovalFenceId(mode.fenceId)) throw new Error("Invalid removal fence id.");
  return removeScript(root, mode.fenceId);
}

const RESULTS: Record<string, RemoteAgentRemovalCommandResult> = {
  removed: { kind: "removed" },
  none: { kind: "none" },
  "busy:inbox": { kind: "busy", lock: "inbox" },
  "busy:registry": { kind: "busy", lock: "registry" },
  "busy:socket": { kind: "busy", lock: "socket" },
  "refused:foreign-owner": { kind: "refused", reason: "foreign-owner" },
  "refused:mount": { kind: "refused", reason: "mount" },
  "refused:layout": { kind: "refused", reason: "layout" },
  "refused:fence": { kind: "refused", reason: "fence" },
};

export function parseRemoteAgentRemovalCommandResult(
  output: string,
): RemoteAgentRemovalCommandResult {
  const result = RESULTS[output.trim()];
  if (!result) throw new Error("Unknown remote agent removal result.");
  return result;
}

/** After a lost reply: `gone` when the tree was already renamed away. */
export function buildRemoteAgentRemovalOutcomeProbe(root: string): string {
  return `set -eu
root=${quote(root)}
if test ! -e "$root" && test ! -L "$root"; then printf gone; else printf present; fi
`;
}
