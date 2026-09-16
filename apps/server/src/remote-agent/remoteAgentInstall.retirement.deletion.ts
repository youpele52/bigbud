import { validateRemoteAgentRuntime } from "./remoteAgentRuntime.ts";

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Build the guarded, idempotent unlink used by both retirement and recovery. */
export function buildRemoteAgentRetirementDeletionCommand(
  runtime: ReturnType<typeof validateRemoteAgentRuntime>,
): string {
  return [
    "set -eu",
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
    'sync -f "$directory"',
    "printf deleted",
  ].join("\n");
}
