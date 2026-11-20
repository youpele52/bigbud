import posix from "node:path/posix";

import { validateRemoteAgentRuntime } from "./remoteAgentRuntime.ts";

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Build the guarded, idempotent unlink used by both retirement and recovery. */
export function buildRemoteAgentRetirementDeletionCommand(
  runtime: ReturnType<typeof validateRemoteAgentRuntime>,
): string {
  const descriptor = validateRemoteAgentRuntime(runtime);
  if (descriptor.origin !== "managed")
    throw new Error("Only managed runtime bytes may be deleted.");
  const root = posix.dirname(posix.dirname(descriptor.statePath));
  return [
    "set -eu",
    `root=${quote(root)}`,
    `binary=${quote(runtime.binaryPath)}`,
    'directory=$(dirname -- "$binary")',
    'test "$(readlink -m -- "$binary")" = "$binary"',
    'if test -e "$binary" || test -L "$binary"; then',
    '  test ! -L "$binary"',
    '  test -f "$binary"',
    '  test "$(stat -c \'%u\' -- "$binary")" = "$(id -u)"',
    '  test "$(stat -c \'%a\' -- "$binary")" = 700',
    `  test "$(sha256sum -- "$binary" | cut -d ' ' -f1)" = '${runtime.sha256}'`,
    '  sync -f "$directory"',
    '  rm -- "$binary"',
    '  sync -f "$directory"',
    "fi",
    'test ! -e "$binary"',
    'test ! -L "$binary"',
    // The digest directory may already have been pruned by an acknowledged prior unlink.
    'sync -f "$root"',
    "remove_empty_owned_directory() {",
    '  candidate="$1"',
    '  case "$candidate" in "$root"/*) ;; *) return 0 ;; esac',
    '  test -d "$candidate" && test ! -L "$candidate" || return 0',
    '  test "$(readlink -f -- "$candidate")" = "$candidate" || return 0',
    '  test "$(stat -c \'%u\' -- "$candidate")" = "$(id -u)" || return 0',
    '  test "$(stat -c \'%a\' -- "$candidate")" = 700 || return 0',
    // rmdir is atomic: a concurrent stage/launch adding an entry keeps the directory intact.
    '  if rmdir -- "$candidate" 2>/dev/null; then',
    '    sync -f "$(dirname -- "$candidate")" || return 0',
    "  fi",
    "  return 0",
    "}",
    'remove_empty_owned_directory "$directory"',
    'remove_empty_owned_directory "$(dirname -- "$directory")"',
    `remove_empty_owned_directory ${quote(runtime.statePath)}`,
    'test ! -e "$binary"',
    'test ! -L "$binary"',
    "printf deleted",
  ].join("\n");
}
