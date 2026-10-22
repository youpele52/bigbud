/**
 * Lists folders on an SSH target for the remote-project folder picker. It uses
 * plain SSH regardless of the target's transport, so it works before the
 * bigbud remote agent is installed, and it never writes on the remote host.
 *
 * @module sshRemoteFolders
 */
import type {
  ServerListRemoteFoldersInput,
  ServerListRemoteFoldersResult,
  ServerRemoteFolder,
} from "@bigbud/contracts/server/server.remoteFolders";

import type { ProcessRunResult } from "../utils/processRunner.ts";
import { runSshCommand, type RunSshCommandInput } from "./sshProcess.ts";

export const REMOTE_FOLDERS_MAX_ENTRIES = 1000;
const REMOTE_FOLDERS_TIMEOUT_MS = 10_000;
const REMOTE_FOLDERS_MAX_BUFFER_BYTES = 1024 * 1024;
const CD_FAILED_EXIT_CODE = 3;

const OUTPUT_MARKER = "BIGBUD_REMOTE_FOLDERS_V1";

/**
 * POSIX sh only (no GNU find), so Linux and macOS remotes both work. Output is
 * NUL-separated after a marker (login shells may print banners first): `$HOME`,
 * the resolved folder, then `g|d<TAB>name` per non-hidden folder (`g` marks a
 * git checkout).
 */
export const LIST_FOLDERS_SCRIPT = [
  'target="$1"',
  `MARKER=${OUTPUT_MARKER}`,
  'case "$target" in',
  '  "") cd || exit 3 ;;',
  '  "~") cd || exit 3 ;;',
  '  "~/"*) cd -- "$HOME/${target#\\~/}" || exit 3 ;;',
  '  *) cd -- "$target" || exit 3 ;;',
  "esac",
  'printf \'%s\\0%s\\0%s\\0\' "$MARKER" "$HOME" "$(pwd)"',
  "for entry in *; do",
  '  [ -d "$entry" ] || continue',
  '  if [ -e "$entry/.git" ]; then kind=g; else kind=d; fi',
  '  printf \'%s\\t%s\\0\' "$kind" "$entry"',
  "done",
].join("\n");

export function parseRemoteFoldersOutput(
  stdout: string,
  stdoutTruncated = false,
): ServerListRemoteFoldersResult {
  const markerIndex = stdout.indexOf(`${OUTPUT_MARKER}\0`);
  if (markerIndex === -1) {
    throw new Error("The remote host returned an unexpected folder listing.");
  }
  const fields = stdout.slice(markerIndex + OUTPUT_MARKER.length + 1).split("\0");
  // A cut-off buffer can end in a partial record.
  if (stdoutTruncated) fields.pop();
  const [homePath = "", path = "", ...records] = fields;
  if (!path.trim()) {
    throw new Error("The remote host did not report a folder path.");
  }
  const folders: ServerRemoteFolder[] = [];
  for (const record of records) {
    const separator = record.indexOf("\t");
    if (separator !== 1) continue;
    const name = record.slice(separator + 1);
    if (!name.trim()) continue;
    folders.push({ name, isGitRepo: record[0] === "g" });
  }
  folders.sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
  return {
    path: path.trim(),
    homePath: homePath.trim() || path.trim(),
    folders: folders.slice(0, REMOTE_FOLDERS_MAX_ENTRIES),
    truncated: stdoutTruncated || folders.length > REMOTE_FOLDERS_MAX_ENTRIES,
  };
}

export async function listRemoteFolders(
  input: ServerListRemoteFoldersInput,
  run: (input: RunSshCommandInput) => Promise<ProcessRunResult> = runSshCommand,
): Promise<ServerListRemoteFoldersResult> {
  const result = await run({
    executionTargetId: input.executionTargetId,
    command: "sh",
    args: ["-c", LIST_FOLDERS_SCRIPT, "sh", input.path ?? ""],
    allowNonZeroExit: true,
    timeoutMs: REMOTE_FOLDERS_TIMEOUT_MS,
    maxBufferBytes: REMOTE_FOLDERS_MAX_BUFFER_BYTES,
    outputMode: "truncate",
  });
  if (result.timedOut) {
    throw new Error("Timed out listing remote folders.");
  }
  if (result.code === CD_FAILED_EXIT_CODE) {
    throw new Error(`Folder not found or not accessible: ${input.path ?? "~"}`);
  }
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `ssh exited with code ${result.code ?? "unknown"}.`;
    throw new Error(`Failed to list remote folders. ${detail}`);
  }
  return parseRemoteFoldersOutput(result.stdout, result.stdoutTruncated === true);
}
