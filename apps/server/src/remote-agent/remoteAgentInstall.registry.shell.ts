import { MAX_REMOTE_AGENT_REGISTRY_BYTES } from "./remoteAgentInstall.registry.ts";
import { hasRemoteAgentPathControls } from "./remoteAgentRuntime.ts";

const encode = (text: string) => Buffer.from(text).toString("base64");

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Linux control metadata lives outside every agent state root and legacy discovery path. */
export function remoteAgentRegistryShellPrelude(root: string): string {
  if (!root.startsWith("/") || hasRemoteAgentPathControls(root))
    throw new Error("Invalid control root.");
  return `set -eu
umask 077
root=${quote(root)}
test "$(readlink -m -- "$root")" = "$root"
private_dir() {
  test ! -L "$1"
  if test ! -e "$1"; then mkdir -m 700 -- "$1"; fi
  test -d "$1"
  test "$(stat -c '%u' -- "$1")" = "$(id -u)"
  test "$(stat -c '%a' -- "$1")" = 700
}
private_file() {
  test ! -L "$1"
  test -f "$1"
  test "$(stat -c '%u' -- "$1")" = "$(id -u)"
  test "$(stat -c '%a' -- "$1")" = 600
  test "$(stat -c '%h' -- "$1")" = 1
}
test -d "$root"
test ! -L "$root"
test "$(readlink -f -- "$root")" = "$root"
private_dir "$root"
private_dir "$root/control-v1"
control="$root/control-v1"
lock="$control/registry.lock"
if test ! -e "$lock" && test ! -L "$lock"; then
  (set -C; : > "$lock") 2>/dev/null || test -f "$lock"
fi
private_file "$lock"
exec 9<> "$lock"
flock -x 9
private_file "$lock"
registry="$control/registry.json"
if test -e "$registry" || test -L "$registry"; then
  private_file "$registry"
  test "$(wc -c < "$registry")" -le ${MAX_REMOTE_AGENT_REGISTRY_BYTES}
fi
# Probe the required Linux durability primitive before any publication.
sync -f "$control"
`;
}

export function buildRemoteAgentRegistryRead(root: string): string {
  return `${remoteAgentRegistryShellPrelude(root)}
if test -f "$registry"; then base64 -w0 "$registry"; else printf 'missing'; fi
`;
}

/** Flush bytes, rename, flush filesystem metadata, THEN acknowledge the committed snapshot. */
export function buildRemoteAgentRegistryCas(input: {
  readonly root: string;
  readonly expected: string | null;
  readonly next: string;
}): string {
  if (Buffer.byteLength(input.next) > MAX_REMOTE_AGENT_REGISTRY_BYTES)
    throw new Error("Registry is full.");
  return `${remoteAgentRegistryShellPrelude(input.root)}
expected=$(mktemp "$control/.expected.XXXXXX")
next=$(mktemp "$control/.next.XXXXXX")
trap 'rm -f -- "$expected" "$next"' EXIT HUP INT TERM
printf '%s' '${input.expected === null ? "" : encode(input.expected)}' | base64 --decode > "$expected"
${
  input.expected === null
    ? 'if test -e "$registry"; then printf conflict; exit 0; fi'
    : 'if ! test -f "$registry" || ! cmp -s -- "$expected" "$registry"; then printf conflict; exit 0; fi'
}
printf '%s' '${encode(input.next)}' | base64 --decode > "$next"
sync -f "$next"
mv -T -- "$next" "$registry"
sync -f "$control"
printf committed
`;
}
