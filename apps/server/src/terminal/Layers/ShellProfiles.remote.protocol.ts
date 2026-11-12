import path from "node:path";
import * as Schema from "effect/Schema";
import {
  TerminalShellProfile,
  type ShellHostScope,
} from "@bigbud/contracts/workspace/terminalShell.ts";
import { shellKind, shellProfileId } from "./ShellProfiles.identity";
import {
  UNIX_SHELL_NAMES,
  UNIX_SHELL_ROOTS,
  unixShellCandidates,
} from "./ShellProfiles.candidates";

export const REMOTE_SHELL_TIMEOUT_MS = 10_000;
export const REMOTE_SHELL_OUTPUT_BYTES = 8192;
const MARKER = "bigbud-shell-inventory-v1";
const END = "end-shell-inventory";
const CANDIDATES = new Set(unixShellCandidates());

/** Trusted static source only. No candidate is executed, sourced, or used to resolve PATH.
 * Roots/names come only from the frozen shared compile-time policy. Physical directories
 * use the shell builtin; file symlinks are retained (no realpath prerequisite).
 */
export const REMOTE_SHELL_PROBE_SCRIPT = `
case "$1" in
  ssh) [ "$#" -eq 2 ] || exit 79 ;;
  wsl) [ "$#" -eq 3 ] || exit 79 ;;
  *) exit 79 ;;
esac
if [ -x /usr/bin/id ]; then id=/usr/bin/id
elif [ -x /bin/id ]; then id=/bin/id
else exit 79; fi
account=$("$id" -un) || exit 79
[ "$account" = "$2" ] || exit 79
if [ "$1" = wsl ]; then
  uid=$("$id" -u) || exit 79
  [ "$uid" = "$3" ] || exit 79
fi
if [ -x /usr/bin/uname ]; then uname=/usr/bin/uname
elif [ -x /bin/uname ]; then uname=/bin/uname
else exit 80; fi
system=$("$uname" -s) || exit 80
case "$system" in Linux) platform=linux ;; Darwin) platform=darwin ;; *) exit 80 ;; esac
[ "$1" != wsl ] || [ "$platform" = linux ] || exit 79
printf '${MARKER}\\000%s\\000' "$platform"
for root in ${UNIX_SHELL_ROOTS.join(" ")}; do
  [ -d "$root" ] || continue
  physical=$(CDPATH= cd -P "$root" && pwd -P) || exit 80
  case "$physical" in /*) ;; *) exit 80 ;; esac
  for name in ${UNIX_SHELL_NAMES.join(" ")}; do
    candidate="$root/$name"
    [ -f "$candidate" ] && [ -x "$candidate" ] || continue
    printf '%s\\000%s\\000' "$candidate" "$physical/$name"
  done
done
printf '${END}\\000'
`;

/** Clear inherited startup/environment configuration before entering the probe shell. */
export const REMOTE_SHELL_CLEAN_SCRIPT =
  'exec /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C /bin/sh -c "$1" sh "$2" "$3" "$4"';

function safePath(value: string): boolean {
  return (
    value.length <= 4096 &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.endsWith("/") &&
    value === path.posix.normalize(value) &&
    // oxlint-disable-next-line no-control-regex -- Inventory is not a terminal output channel.
    !/[\x00-\x1f\x7f-\x9f\u{2028}\u{2029}\u{FFFD}\uD800-\uDFFF]/u.test(value)
  );
}

/** Entire-frame validation: never search for a marker after startup noise or salvage rows. */
export function decodeRemoteShellInventory(
  raw: string,
  host: ShellHostScope,
): readonly TerminalShellProfile[] {
  if (Buffer.byteLength(raw, "utf8") > REMOTE_SHELL_OUTPUT_BYTES)
    throw new Error("Remote inventory exceeded its output limit.");
  const fields = raw.split("\0");
  const platform = fields[1];
  if (
    fields[0] !== MARKER ||
    (platform !== "linux" && platform !== "darwin") ||
    (host.kind === "wsl" && platform !== "linux") ||
    (host.kind !== "wsl" && host.kind !== "ssh") ||
    fields.at(-1) !== "" ||
    fields.at(-2) !== END ||
    fields.length < 4 ||
    (fields.length - 4) % 2 !== 0 ||
    (fields.length - 4) / 2 > 64
  )
    throw new Error("Malformed remote shell inventory.");
  const profiles: TerminalShellProfile[] = [];
  const seenCandidates = new Set<string>();
  const seenProfiles = new Set<string>();
  for (let index = 2; index < fields.length - 2; index += 2) {
    const candidate = fields[index]!;
    const executable = fields[index + 1]!;
    if (
      !CANDIDATES.has(candidate) ||
      seenCandidates.has(candidate) ||
      !safePath(executable) ||
      path.posix.basename(executable) !== path.posix.basename(candidate)
    )
      throw new Error("Invalid remote shell path.");
    seenCandidates.add(candidate);
    const kind = shellKind(candidate, platform);
    const args = kind === "zsh" ? ["-o", "nopromptsp"] : [];
    const profileId = shellProfileId(host, executable, args, platform);
    const profile = Schema.decodeUnknownSync(TerminalShellProfile)({
      profileId,
      host,
      kind,
      displayName: path.posix.basename(candidate),
      executable,
      args,
      platform,
      availability: "available",
      integration: { status: "unavailable", reason: "not-qualified" },
    });
    if (!seenProfiles.has(profileId)) profiles.push(profile);
    seenProfiles.add(profileId);
  }
  return profiles;
}
