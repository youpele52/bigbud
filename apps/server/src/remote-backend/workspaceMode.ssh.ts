/**
 * Workspace-mode store on an SSH host. Runs through the application-owned `clean-posix` wrapper;
 * the real path, account uid, account home and machine identity are all resolved ON the host, so
 * symlinks and alias paths collapse to one reservation key. Layout and CAS match
 * `workspaceMode.local.ts`: exclusive `ln` of a complete temp file publishes a generation.
 *
 * @module workspaceMode.ssh
 */
import { runSshCommand } from "../ssh/sshProcess.ts";
import {
  decodeWorkspaceModeRecord,
  encodeWorkspaceModeRecord,
  isValidWorkspaceModeIdentity,
  MAX_WORKSPACE_MODE_RECORD_BYTES,
  WORKSPACE_MODE_DIRECTORY,
  workspaceModeKey,
  type WorkspaceModeInspection,
  type WorkspaceModeRecord,
  type WorkspaceModeStore,
} from "./workspaceMode.record.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const RETRIES = 4;
const hasControlCharacters = (value: string) =>
  [...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);

/** Host facts and private directories; every failure is a stdout verdict, never a guess. */
const PRELUDE = `set -eu
umask 077
verdict() { printf '%s\\n' "$*"; exit 0; }
case "$(uname -s)" in Linux) ;; *) verdict unsupported not-linux ;; esac
uid=$(id -u)
home=$(getent passwd "$uid" 2>/dev/null | cut -d: -f6) || home=
if test -z "$home"; then home=$(awk -F: -v u="$uid" '$3 == u { print $6; exit }' /etc/passwd); fi
case "$home" in /*) ;; *) verdict unsafe the account home directory is unknown ;; esac
raw=
for f in /etc/machine-id /var/lib/dbus/machine-id; do
  candidate=$(cat "$f" 2>/dev/null | tr 'A-F' 'a-f') || candidate=
  if printf '%s\\n' "$candidate" | grep -Eqx '[0-9a-f]{32}'; then raw=$candidate; break; fi
done
test -n "$raw" || verdict unsupported no-machine-id
host=machine-v1:$(printf 'bigbud.machine-identity.v1\\000%s' "$raw" | sha256sum | cut -d' ' -f1)
owned_dir() {
  if test -L "$1"; then verdict unsafe "$1" is a symlink; fi
  if test ! -e "$1"; then mkdir -m 700 -- "$1" 2>/dev/null || :; fi
  if test -L "$1" || test ! -d "$1"; then verdict unsafe "$1" is not a directory; fi
  test -n "$(find "$1" -prune -type d -user "$uid" $2 -print)" ||
    verdict unsafe "$1" must be owned by this account $3
}
reservation_dir() {
  owned_dir "$home/.bigbud" "" ""
  owned_dir "$home/.bigbud/${WORKSPACE_MODE_DIRECTORY}" "-perm 700" "with mode 0700"
  dir="$home/.bigbud/${WORKSPACE_MODE_DIRECTORY}/$1"
  owned_dir "$dir" "-perm 700" "with mode 0700"
}
latest_generation() {
  latest=0
  for f in "$dir"/*.json; do
    n=\${f##*/}; n=\${n%.json}
    case "$n" in ''|0*|*[!0-9]*) continue ;; esac
    test "\${#n}" -le 16 || continue
    if test "$n" -gt "$latest"; then latest=$n; fi
  done
}
`;

export function buildWorkspaceModeInspect(workspaceRoot: string): string {
  if (!workspaceRoot.startsWith("/") || hasControlCharacters(workspaceRoot))
    throw new Error(
      "Workspace folders on SSH hosts must be absolute paths without control characters.",
    );
  return `${PRELUDE}
real=$(cd -P -- ${quote(workspaceRoot)} 2>/dev/null && pwd -P) || verdict missing-folder
rsha=$(printf '%s' "$real" | sha256sum | cut -d' ' -f1)
key=$(printf '%s\\n%s\\n%s' "$host" "$uid" "$rsha" | sha256sum | cut -d' ' -f1)
reservation_dir "$key"
latest_generation
if test "$latest" = 0; then verdict ready "$host" "$uid" "$rsha" 0 missing; fi
file="$dir/$latest.json"
if test ! -e "$file" && test ! -L "$file"; then verdict retry; fi
if test -L "$file" || test -z "$(find "$file" -prune -type f -user "$uid" -perm 600 -print)"; then
  verdict unsafe "$file" must be a private file owned by this account
fi
test "$(wc -c < "$file")" -le ${MAX_WORKSPACE_MODE_RECORD_BYTES} || verdict unsafe "$file" is too large
content=$(base64 < "$file" 2>/dev/null | tr -d '\\n')
test -n "$content" || verdict retry
verdict ready "$host" "$uid" "$rsha" "$latest" "$content"
`;
}

/** Exclusive `ln` (link(2) never replaces) is the CAS; the previous generation is kept. */
export function buildWorkspaceModePublish(next: WorkspaceModeRecord): string {
  const content = Buffer.from(encodeWorkspaceModeRecord(next)).toString("base64");
  return `${PRELUDE}
test "$host" = ${quote(next.hostIdentity)} || verdict unsafe the host identity changed
test "$uid" = ${next.accountUid} || verdict unsafe the account changed
reservation_dir ${workspaceModeKey(next)}
tmp=$(mktemp "$dir/.tmp.XXXXXX")
trap 'rm -f -- "$tmp"' EXIT HUP INT TERM
printf '%s' '${content}' | base64 -d > "$tmp"
sync "$tmp" 2>/dev/null || sync
target="$dir/${next.generation}.json"
if ! ln -- "$tmp" "$target" 2>/dev/null; then
  if test -e "$target" || test -L "$target"; then verdict conflict; fi
  verdict unsafe could not publish "$target"
fi
sync -f "$dir" 2>/dev/null || sync
for f in "$dir"/*.json; do
  n=\${f##*/}; n=\${n%.json}
  case "$n" in ''|0*|*[!0-9]*) continue ;; esac
  if test "\${#n}" -le 16 && test "$n" -lt ${next.generation - 1}; then rm -f -- "$f"; fi
done
verdict committed
`;
}

function parseInspection(output: string, workspaceRoot: string): WorkspaceModeInspection | "retry" {
  const [verdict, ...fields] = output.trim().split(" ");
  if (verdict === "retry") return "retry";
  if (verdict === "unsupported") return { kind: "unsupported", reason: fields.join(" ") };
  if (verdict === "missing-folder")
    throw new Error(`'${workspaceRoot}' does not exist on the host or is not a folder.`);
  if (verdict === "unsafe")
    throw new Error(`Workspace mode storage is unsafe: ${fields.join(" ")}.`);
  const [hostIdentity, uid, realpathSha256, generation, content] = fields;
  const identity = {
    hostIdentity: hostIdentity!,
    accountUid: Number(uid),
    realpathSha256: realpathSha256!,
  };
  if (verdict !== "ready" || fields.length !== 5 || !isValidWorkspaceModeIdentity(identity))
    throw new Error("Unexpected workspace mode response from the host.");
  if (content === "missing") return { kind: "ready", identity, current: null };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(content!))
    throw new Error("Invalid workspace mode record encoding.");
  const current = decodeWorkspaceModeRecord(Buffer.from(content!, "base64").toString("utf8"));
  if (String(current.generation) !== generation)
    throw new Error("Workspace mode record names another generation.");
  return { kind: "ready", identity, current };
}

export type WorkspaceModeShellRunner = (script: string) => Promise<string>;

export function makeShellWorkspaceModeStore(run: WorkspaceModeShellRunner): WorkspaceModeStore {
  return {
    inspect: async (workspaceRoot) => {
      for (let attempt = 0; attempt < RETRIES; attempt++) {
        const result = parseInspection(
          await run(buildWorkspaceModeInspect(workspaceRoot)),
          workspaceRoot,
        );
        if (result !== "retry") return result;
      }
      throw new Error("Workspace mode records changed too quickly to read.");
    },
    publish: async (next) => {
      const [verdict, ...detail] = (await run(buildWorkspaceModePublish(next))).trim().split(" ");
      if (verdict === "committed" || verdict === "conflict") return verdict;
      throw new Error(`Workspace mode publication failed: ${detail.join(" ") || "no verdict"}.`);
    },
  };
}

/** Production runner: clean-posix wrapper over the target's verified SSH transport. */
export const makeSshWorkspaceModeStore = (executionTargetId: string, timeoutMs = 15_000) =>
  makeShellWorkspaceModeStore(async (script) => {
    const result = await runSshCommand({
      executionTargetId,
      shellMode: "clean-posix",
      command: "/bin/sh",
      args: ["-c", script],
      timeoutMs,
      maxBufferBytes: 64 * 1024,
    });
    return result.stdout;
  });
