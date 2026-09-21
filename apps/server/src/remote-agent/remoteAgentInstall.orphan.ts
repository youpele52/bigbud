import type { RemoteAgentControl } from "./remoteAgentControl.ts";
import type {
  RemoteAgentInventory,
  RemoteAgentInventoryEntry,
} from "./remoteAgentUpdate.inventory.ts";

const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function managedIdentity(root: string, entry: RemoteAgentInventoryEntry) {
  const prefix = `${root}/bin/`;
  if (entry.kind !== "managed" || !entry.path.startsWith(prefix)) return null;
  const [version, digest, filename, ...extra] = entry.path.slice(prefix.length).split("/");
  if (
    extra.length > 0 ||
    filename !== "bigbud-remote-agent" ||
    !version ||
    !SAFE_VERSION.test(version) ||
    !digest ||
    !SHA256.test(digest) ||
    digest !== entry.digest
  )
    return null;
  return { version, digest, binaryPath: entry.path };
}

function orphanDeletionCommand(input: {
  readonly root: string;
  readonly version: string;
  readonly digest: string;
  readonly binaryPath: string;
}): string {
  return [
    "set -eu",
    `root=${quote(input.root)}`,
    `version=${quote(input.version)}`,
    `digest=${quote(input.digest)}`,
    `binary=${quote(input.binaryPath)}`,
    'version_root="$root/bin/$version"',
    'directory="$version_root/$digest"',
    'test "$binary" = "$directory/bigbud-remote-agent"',
    'for path in "$root" "$root/bin" "$version_root" "$directory"; do',
    '  test ! -L "$path"',
    '  test -d "$path"',
    '  test "$(readlink -f -- "$path")" = "$path"',
    '  test "$(stat -c \'%u\' -- "$path")" = "$(id -u)"',
    '  test "$(stat -c \'%a\' -- "$path")" = 700',
    "done",
    'test ! -L "$binary"',
    'test -f "$binary"',
    'test "$(readlink -f -- "$binary")" = "$binary"',
    'test "$(stat -c \'%u\' -- "$binary")" = "$(id -u)"',
    'test "$(stat -c \'%a\' -- "$binary")" = 700',
    'test "$(sha256sum -- "$binary" | cut -d \' \' -f1)" = "$digest"',
    'test "$(find -P "$directory" -mindepth 1 -maxdepth 1 | wc -l)" -eq 1',
    'for link in "$root/bin/current" "$root/bin/previous"; do',
    '  if test -L "$link"; then',
    '    target=$(readlink -f -- "$link")',
    '    test "$target" != "$binary"',
    '  elif test -e "$link"; then exit 1; fi',
    "done",
    "for executable in /proc/[0-9]*/exe; do",
    '  target=$(readlink -f -- "$executable" 2>/dev/null) || continue',
    '  test "$target" != "$binary"',
    "done",
    'sync -f "$directory"',
    'rm -- "$binary"',
    'sync -f "$directory"',
    'rmdir -- "$directory"',
    'rmdir -- "$version_root" 2>/dev/null || :',
    "printf reclaimed",
  ].join("\n");
}

/** Reclaim one exact managed-layout payload omitted from the registry by an older installer. */
export async function reclaimUnregisteredRemoteAgentBuild(input: {
  readonly control: RemoteAgentControl;
  readonly inventory: RemoteAgentInventory;
  readonly referencedBuildIds?: () => Promise<ReadonlySet<string>>;
}): Promise<boolean> {
  if (
    input.inventory.noncompliant ||
    input.inventory.uncertain ||
    input.inventory.untracked ||
    !input.referencedBuildIds
  )
    return false;

  let referenced: ReadonlySet<string>;
  try {
    referenced = await input.referencedBuildIds();
  } catch {
    return false;
  }
  const state = await input.control.registry.read();
  const pathCounts = new Map<string, number>();
  for (const entry of input.inventory.entries)
    pathCounts.set(entry.path, (pathCounts.get(entry.path) ?? 0) + 1);

  for (const entry of input.inventory.entries) {
    const identity = managedIdentity(input.control.root, entry);
    if (!identity || pathCounts.get(entry.path) !== 1) continue;
    if (
      state.builds.some(
        (build) =>
          build.binary !== "absent" &&
          (build.runtime.binaryPath === identity.binaryPath ||
            build.runtime.sha256 === identity.digest),
      ) ||
      [...referenced].some((buildId) =>
        buildId.startsWith(`${identity.version}:${identity.digest}:`),
      )
    )
      continue;

    try {
      const result = await input.control.run(
        orphanDeletionCommand({ root: input.control.root, ...identity }),
      );
      if (result.trim() === "reclaimed") return true;
    } catch {
      return false;
    }
  }
  return false;
}
