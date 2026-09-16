import type { RemoteAgentControl } from "./remoteAgentControl.ts";

const SAFE_ROOT = /^\/[A-Za-z0-9._+@%/:=-]*$/;

export interface RemoteAgentInventoryEntry {
  readonly digest: string;
  readonly path: string;
  readonly kind: "managed" | "legacy" | "staging" | "unknown";
}

export interface RemoteAgentInventory {
  readonly entries: ReadonlyArray<RemoteAgentInventoryEntry>;
  readonly uniqueDigests: ReadonlySet<string>;
  readonly partialCandidate: boolean;
  readonly unknownOwner: boolean;
  readonly untracked: boolean;
  readonly uncertain: boolean;
  readonly noncompliant: boolean;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function decode(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

/**
 * Inventory is intentionally independent from registry metadata. It sees partial
 * payloads and aliases before a controller decides whether another slot exists.
 */
export function buildRemoteAgentInventoryCommand(root: string): string {
  if (!SAFE_ROOT.test(root) || root.includes("\0")) throw new Error("Invalid inventory root.");
  const encodedRoot = quote(root);
  return `set -eu
root=${encodedRoot}
bin="$root/bin"
staging="$root/staging"
test ! -L "$root"
test -d "$root"
test "$(readlink -f -- "$root")" = "$root"
test ! -L "$bin"
test ! -L "$staging"
printf 'remote-agent-inventory-v1\\n'
MAX_SYMLINK_HOPS=32

has_symlink_parent() {
  parent=$(dirname -- "$1")
  while test "$parent" != / && test "$parent" != .; do
    if test -L "$parent"; then return 0; fi
    next=$(dirname -- "$parent")
    test "$next" != "$parent" || break
    parent=$next
  done
  return 1
}

resolve_file() {
  current=$1
  hops=0
  while test -L "$current"; do
    has_symlink_parent "$current" && return 1
    test "$hops" -lt "$MAX_SYMLINK_HOPS" || return 1
    next=$(readlink -- "$current") || return 1
    test -n "$next" || return 1
    case "$next" in
      /*) current=$next;;
      *) current=$(dirname -- "$current")/$next;;
    esac
    hops=$((hops + 1))
  done
  has_symlink_parent "$current" && return 1
  test -e "$current" || return 1
  canonical=$(readlink -f -- "$current") || return 1
  test -f "$canonical" || return 1
  printf '%s\\n' "$canonical"
}

emit_file() {
  path=$1
  kind=$2
  digest=$(sha256sum -- "$path" | awk '{print $1}') || { printf 'uncertain\\n'; return 0; }
  test "$(printf '%s' "$digest" | wc -c)" -eq 64 || { printf 'uncertain\\n'; return 0; }
  case "$digest" in *[!a-f0-9]*) printf 'uncertain\\n'; return 0;; esac
  printf 'file\\t%s\\t%s\\t%s\\n' "$digest" "$kind" "$(printf '%s' "$path" | base64 -w0)"
}
if test -d "$bin" && test ! -L "$bin"; then
  find -P "$bin" -type f -exec sh -c '
    for path do
    digest=$(sha256sum -- "$path" | awk '\\''{print $1}'\\'') || { printf '\\''uncertain\\n'\\''; continue; }
      test "$(printf '%s' "$digest" | wc -c)" -eq 64 || { printf '\\''uncertain\\n'\\''; continue; }
      case "$digest" in *[!a-f0-9]*) printf '\\''uncertain\\n'\\''; continue;; esac
      case "$path" in
        "$0"/*/*/bigbud-remote-agent) kind=managed;;
        *) kind=unknown;;
      esac
      printf '\\''file\\t%s\\t%s\\t%s\\n'\\'' "$digest" "$kind" "$(printf '\\''%s'\\'' "$path" | base64 -w0)"
    done
  ' "$bin" {} +
fi
if test -d "$staging" && test ! -L "$staging"; then
  find -P "$staging" -type f ! -name '*.lock' ! -name '*.fence' -exec sh -c '
    for path do
    digest=$(sha256sum -- "$path" | awk '\\''{print $1}'\\'') || { printf '\\''uncertain\\n'\\''; continue; }
      test "$(printf '%s' "$digest" | wc -c)" -eq 64 || { printf '\\''uncertain\\n'\\''; continue; }
      case "$digest" in *[!a-f0-9]*) printf '\\''uncertain\\n'\\''; continue;; esac
      printf '\\''file\\t%s\\tstaging\\t%s\\n'\\'' "$digest" "$(printf '\\''%s'\\'' "$path" | base64 -w0)"
    done
  ' sh {} +
fi
scan_arbitrary_links() {
  base=$1
  find -P "$base" -type l ! -name '*.lock' ! -name '*.fence' \\
    ! -path "$bin/current" ! -path "$bin/previous" -exec sh -c '
    bin=$0
    staging=$1
    shift 2
    MAX_SYMLINK_HOPS=32
    has_symlink_parent() {
      parent=$(dirname -- "$1")
      while test "$parent" != / && test "$parent" != .; do
        if test -L "$parent"; then return 0; fi
        next=$(dirname -- "$parent")
        test "$next" != "$parent" || break
        parent=$next
      done
      return 1
    }
    resolve_executable() {
      current=$1
      hops=0
      while test -L "$current"; do
        has_symlink_parent "$current" && return 1
        test "$hops" -lt "$MAX_SYMLINK_HOPS" || return 1
        next=$(readlink -- "$current") || return 1
        test -n "$next" || return 1
        case "$next" in
          /*) current=$next;;
          *) current=$(dirname -- "$current")/$next;;
        esac
        hops=$((hops + 1))
      done
      has_symlink_parent "$current" && return 1
      test -e "$current" || return 1
      canonical=$(readlink -f -- "$current") || return 1
      test -f "$canonical" && test -x "$canonical" || return 2
      printf '\\''%s\\n'\\'' "$canonical"
    }
    emit_link() {
      link=$1
      status=0
      target=$(resolve_executable "$link") || status=$?
      case "$status" in
        0)
          case "$target" in
            "$bin"/*/*/bigbud-remote-agent) kind=managed;;
            "$staging"/*) kind=staging;;
            *) kind=unknown;;
          esac
          digest=$(sha256sum -- "$target" | awk '\\''{print $1}'\\'') || { printf '\\''uncertain\\n'\\''; return; }
          test "$(printf '%s' "$digest" | wc -c)" -eq 64 || { printf '\\''uncertain\\n'\\''; return; }
          case "$digest" in *[!a-f0-9]*) printf '\\''uncertain\\n'\\''; return;; esac
          printf '\\''file\\t%s\\t%s\\t%s\\n'\\'' "$digest" "$kind" "$(printf '\\''%s'\\'' "$target" | base64 -w0)"
          ;;
        1) printf '\\''unknown\\nuncertain\\n'\\'';;
        2) :;;
        *) printf '\\''unknown\\nuncertain\\n'\\'';;
      esac
    }
    for path do emit_link "$path"; done
  ' "$bin" "$staging" {} +
}
if test -d "$bin" && test ! -L "$bin"; then scan_arbitrary_links "$bin"; fi
if test -d "$staging" && test ! -L "$staging"; then scan_arbitrary_links "$staging"; fi

if test -d "$bin" && test ! -L "$bin"; then
  for link in "$bin/current" "$bin/previous"; do
    if test -L "$link"; then
      target=$(resolve_file "$link") || { printf 'unknown\\n'; continue; }
      case "$target" in "$bin"/*) emit_file "$target" managed;; *) emit_file "$target" legacy;; esac
    fi
  done
fi
`;
}

export function parseRemoteAgentInventory(text: string): RemoteAgentInventory {
  const lines = text.trimEnd().split("\n");
  if (lines[0] !== "remote-agent-inventory-v1") throw new Error("Invalid remote agent inventory.");
  const entries: RemoteAgentInventoryEntry[] = [];
  let uncertain = false;
  let unknownOwner = false;
  let untracked = false;
  let partialCandidate = false;
  for (const line of lines.slice(1)) {
    if (!line) continue;
    if (line === "uncertain") {
      uncertain = true;
      continue;
    }
    if (line === "unknown") {
      unknownOwner = true;
      untracked = true;
      continue;
    }
    const [tag, digest, kind, encodedPath] = line.split("\t");
    if (tag !== "file" || !/^[a-f0-9]{64}$/.test(digest ?? "") || !encodedPath)
      throw new Error("Invalid remote agent inventory entry.");
    if (kind !== "managed" && kind !== "legacy" && kind !== "staging" && kind !== "unknown")
      throw new Error("Invalid remote agent inventory owner.");
    const path = decode(encodedPath);
    if (!path.startsWith("/") || path.includes("\0")) throw new Error("Invalid inventory path.");
    if (kind === "staging") partialCandidate = true;
    entries.push({ digest: digest!, path, kind });
    if (kind === "legacy") unknownOwner = true;
    if (kind === "unknown") {
      unknownOwner = true;
      untracked = true;
    }
  }
  const uniqueDigests = new Set(entries.map((entry) => entry.digest));
  return {
    entries,
    uniqueDigests,
    partialCandidate,
    unknownOwner,
    untracked,
    uncertain,
    noncompliant: uncertain || untracked || uniqueDigests.size > 2,
  };
}

export async function inspectRemoteAgentInventory(
  control: Pick<RemoteAgentControl, "root" | "run">,
): Promise<RemoteAgentInventory> {
  return parseRemoteAgentInventory(
    await control.run(buildRemoteAgentInventoryCommand(control.root)),
  );
}
