import { posix } from "node:path";

import type { PickerProofWorkspaceIndex } from "../ssh/sshOwnerPickerProof.codec.workspace.ts";
import { matchGlob } from "./http.threadTools.remoteWorkspaceGlob.ts";
import { applyFilePatch, parseUnifiedPatch } from "./http.threadTools.remoteWorkspacePatch.ts";
import {
  runTypedSshToolCommand,
  type TypedSshToolCapability,
} from "../tool-transport/toolTransport.ssh.owner.ts";

/**
 * Typed remote workspace tools for the generated MCP and Pi bridges
 * (`remote_workspace_process` with `remoteTool`). Under the SSH owner the
 * request runs on the owner's typed workspace verbs for the authorized target
 * and root (`runTypedSshToolCommand`); on the legacy path the same tool runs
 * the fixed script it always used. The bridges therefore send one shape in
 * both modes and never a raw process envelope for these actions.
 *
 * @module http.threadTools.remoteWorkspaceTool
 */
export type RemoteWorkspaceTool =
  | { readonly tool: "read_text"; readonly path: string }
  | { readonly tool: "write_text"; readonly path: string; readonly content: string }
  | { readonly tool: "list_dir"; readonly path: string }
  | {
      readonly tool: "search";
      readonly pattern: string;
      readonly path: string;
      readonly limit: number;
    }
  | { readonly tool: "apply_patch"; readonly patch: string }
  | {
      readonly tool: "glob";
      readonly pattern: string;
      readonly path: string;
      readonly limit: number;
    };

export type RemoteWorkspaceToolResult =
  | { readonly tool: "read_text"; readonly content: string }
  | { readonly tool: "write_text"; readonly path: string }
  | {
      readonly tool: "list_dir";
      readonly entries: ReadonlyArray<{ readonly name: string; readonly directory: boolean }>;
      readonly truncated: boolean;
    }
  | {
      readonly tool: "search";
      readonly matches: ReadonlyArray<{
        readonly path: string;
        readonly line: number;
        readonly text: string;
      }>;
      readonly truncated: boolean;
    }
  | { readonly tool: "apply_patch"; readonly files: ReadonlyArray<string> }
  | { readonly tool: "glob"; readonly paths: ReadonlyArray<string>; readonly truncated: boolean };

/** The owner's bounded workspace index, for the typed `glob`. */
export type WorkspaceIndexRead = (signal?: AbortSignal) => Promise<PickerProofWorkspaceIndex>;

/** The legacy fixed-script runner (unchanged remote process transport). */
export type LegacyToolRun = (
  command: string,
  args: ReadonlyArray<string>,
  options?: { readonly stdin?: string; readonly allowNonZeroExit?: boolean },
) => Promise<{ readonly stdout: string; readonly stderr: string; readonly code: number | null }>;

const MAX_PATH_BYTES = 4096;
const MAX_SEARCH_LIMIT = 500;
const REGEX_META = /[\\^$.|?*+()[\]{}]/;

export class RemoteWorkspaceToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteWorkspaceToolError";
  }
}

const fail = (message: string): never => {
  throw new RemoteWorkspaceToolError(message);
};
const text = (value: unknown, label: string, allowEmpty = false): string =>
  typeof value === "string" && (allowEmpty || value.length > 0) && !value.includes("\0")
    ? value
    : fail(`${label} is required.`);

export function decodeRemoteWorkspaceTool(value: unknown): RemoteWorkspaceTool {
  const input = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  switch (input.tool) {
    case "read_text":
    case "list_dir":
      return { tool: input.tool, path: text(input.path ?? ".", "path") };
    case "write_text":
      return {
        tool: "write_text",
        path: text(input.path, "path"),
        content: text(input.content, "content", true),
      };
    case "search": {
      const limit = Number(input.limit ?? 100);
      return {
        tool: "search",
        pattern: text(input.pattern, "pattern"),
        path: text(input.path ?? ".", "path"),
        limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_SEARCH_LIMIT) : 100,
      };
    }
    case "apply_patch":
      return { tool: "apply_patch", patch: text(input.patch, "patch") };
    case "glob": {
      const limit = Number(input.limit ?? 1000);
      return {
        tool: "glob",
        pattern: text(input.pattern, "pattern"),
        path: text(input.path ?? ".", "path"),
        limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 5000) : 1000,
      };
    }
    default:
      return fail("Unknown remote workspace tool.");
  }
}

/** Root-relative path for the owner; anything outside the root is refused. */
export function rootRelative(root: string, path: string): string {
  if (Buffer.byteLength(path) > MAX_PATH_BYTES) fail("The path is too long.");
  const absolute = posix.normalize(path.startsWith("/") ? path : posix.join(root, path));
  if (absolute === root) return "";
  if (!absolute.startsWith(`${root}/`)) fail(`The path is outside the workspace: ${path}`);
  return absolute.slice(root.length + 1);
}

async function parentsFor(capability: TypedSshToolCapability, relativePath: string) {
  const parts = relativePath.split("/").slice(0, -1);
  for (let index = 1; index <= parts.length; index += 1) {
    await runTypedSshToolCommand({
      capability,
      command: { kind: "directory.create", relativePath: parts.slice(0, index).join("/") },
    });
  }
}

/** Owner path: typed verbs only, inside the authorized root. */
export async function runOwnedRemoteWorkspaceTool(
  capability: TypedSshToolCapability,
  tool: RemoteWorkspaceTool,
  signal?: AbortSignal,
  index?: WorkspaceIndexRead,
): Promise<RemoteWorkspaceToolResult> {
  const root = capability.workspaceRoot;
  switch (tool.tool) {
    case "read_text": {
      const relativePath = rootRelative(root, tool.path);
      const file = await runTypedSshToolCommand({
        capability,
        command: { kind: "file.read", relativePath },
        signal,
      });
      if (file.kind !== "file") return fail("Unexpected owner reply.");
      return { tool: "read_text", content: new TextDecoder().decode(file.data) };
    }
    case "write_text": {
      const relativePath = rootRelative(root, tool.path);
      if (!relativePath) return fail("Cannot write the workspace root.");
      await parentsFor(capability, relativePath);
      await runTypedSshToolCommand({
        capability,
        command: { kind: "file.write", relativePath, contents: tool.content },
        signal,
      });
      return { tool: "write_text", path: tool.path };
    }
    case "list_dir": {
      const listed = await runTypedSshToolCommand({
        capability,
        command: { kind: "directory.list", relativeDir: rootRelative(root, tool.path) },
        signal,
      });
      if (listed.kind !== "directory") return fail("Unexpected owner reply.");
      return { tool: "list_dir", entries: listed.entries, truncated: listed.truncated };
    }
    case "search": {
      // The owner search is fixed-string and case-insensitive over the root.
      if (REGEX_META.test(tool.pattern))
        fail(
          "Regular-expression grep is not a typed owner verb; search a literal string, or run rg through bash.",
        );
      const scope = rootRelative(root, tool.path);
      const found = await runTypedSshToolCommand({
        capability,
        command: { kind: "search.contents", query: tool.pattern, limit: MAX_SEARCH_LIMIT },
        signal,
      });
      if (found.kind !== "search") return fail("Unexpected owner reply.");
      const matches = found.value.matches
        .filter((match) => !scope || match.path === scope || match.path.startsWith(`${scope}/`))
        .slice(0, tool.limit)
        .map((match) => ({ path: match.path, line: match.line, text: match.lineText }));
      return {
        tool: "search",
        matches,
        truncated: found.value.truncated || matches.length === tool.limit,
      };
    }
    case "apply_patch":
      return applyOwnedPatch(capability, tool.patch, signal);
    case "glob": {
      if (!index) return fail("The owner workspace index is not available.");
      const scope = rootRelative(root, tool.path);
      const listed = await index(signal);
      const paths = matchGlob(listed.entries, scope, tool.pattern, tool.limit);
      return { tool: "glob", paths, truncated: listed.truncated || paths.length >= tool.limit };
    }
  }
}

/** Every file is read and patched before anything is written. */
async function applyOwnedPatch(
  capability: TypedSshToolCapability,
  patch: string,
  signal?: AbortSignal,
): Promise<RemoteWorkspaceToolResult> {
  const root = capability.workspaceRoot;
  const planned: Array<{ relativePath: string; contents: string | null; display: string }> = [];
  for (const file of parseUnifiedPatch(patch)) {
    const source = file.oldPath === null ? null : rootRelative(root, file.oldPath);
    let original = "";
    if (source !== null) {
      const read = await runTypedSshToolCommand({
        capability,
        command: { kind: "file.read", relativePath: source },
        signal,
      });
      if (read.kind !== "file" || read.truncated) return fail(`Cannot patch ${file.oldPath}.`);
      original = new TextDecoder().decode(read.data);
    }
    if (file.newPath === null) {
      if (source === null) return fail("A patch section names no file.");
      planned.push({ relativePath: source, contents: null, display: file.oldPath! });
      continue;
    }
    planned.push({
      relativePath: rootRelative(root, file.newPath),
      contents: applyFilePatch(original, file),
      display: file.newPath,
    });
  }
  for (const step of planned) {
    if (step.contents === null) {
      await runTypedSshToolCommand({
        capability,
        command: { kind: "entry.delete", relativePath: step.relativePath, expectedKind: "file" },
        signal,
      });
      continue;
    }
    await parentsFor(capability, step.relativePath);
    await runTypedSshToolCommand({
      capability,
      command: { kind: "file.write", relativePath: step.relativePath, contents: step.contents },
      signal,
    });
  }
  return { tool: "apply_patch", files: planned.map((step) => step.display) };
}

const READ_SCRIPT = [
  "set -eu",
  "target=$1",
  'if [ ! -e "$target" ]; then printf "Path not found: %s\\n" "$target" >&2; exit 1; fi',
  'if [ ! -f "$target" ]; then printf "Not a file: %s\\n" "$target" >&2; exit 1; fi',
  'cat "$target"',
].join("\n");
const WRITE_SCRIPT = [
  "set -eu",
  "target=$1",
  'mkdir -p "$(dirname "$target")"',
  'cat > "$target"',
].join("\n");
const LIST_SCRIPT = [
  'find "$1" -mindepth 1 -maxdepth 1 | sort | head -n "$2" | while IFS= read -r entry; do',
  '  if [ -d "$entry" ]; then printf "d %s\\n" "${entry##*/}"; else printf "f %s\\n" "${entry##*/}"; fi',
  "done",
].join("\n");
const SEARCH_SCRIPT = [
  'if command -v rg >/dev/null 2>&1; then rg -n --no-heading --color never --max-count "$3" -- "$1" "$2";',
  'else grep -R -n -- "$1" "$2" | head -n "$3"; fi',
].join("\n");
const PATCH_SCRIPT = [
  "set -eu",
  "if command -v git >/dev/null 2>&1; then git apply --whitespace=nowarn - || patch -p0 -N; else patch -p0 -N; fi",
].join("\n");
const GLOB_SCRIPT = [
  'if ! command -v rg >/dev/null 2>&1; then printf "ripgrep is required for glob on the remote host.\\n" >&2; exit 1; fi',
  'cd "$1" && rg --files -g "$2" | head -n "$3"',
].join("\n");
const LIST_LIMIT = 1000;

/** Legacy path: the fixed scripts the bridges used to send, now chosen server-side. */
export async function runLegacyRemoteWorkspaceTool(
  run: LegacyToolRun,
  tool: RemoteWorkspaceTool,
): Promise<RemoteWorkspaceToolResult> {
  switch (tool.tool) {
    case "read_text": {
      const result = await run("sh", ["-lc", READ_SCRIPT, "bigbud-read", tool.path]);
      return { tool: "read_text", content: result.stdout };
    }
    case "write_text":
      await run("sh", ["-lc", WRITE_SCRIPT, "bigbud-write", tool.path], { stdin: tool.content });
      return { tool: "write_text", path: tool.path };
    case "list_dir": {
      const result = await run(
        "sh",
        ["-lc", LIST_SCRIPT, "bigbud-list", tool.path, String(LIST_LIMIT)],
        {
          allowNonZeroExit: true,
        },
      );
      const entries = result.stdout
        .split("\n")
        .filter((line) => line.length > 2)
        .map((line) => ({ name: line.slice(2), directory: line.startsWith("d ") }));
      return { tool: "list_dir", entries, truncated: entries.length >= LIST_LIMIT };
    }
    case "search": {
      const result = await run(
        "sh",
        ["-lc", SEARCH_SCRIPT, "bigbud-search", tool.pattern, tool.path, String(tool.limit)],
        { allowNonZeroExit: true },
      );
      const matches = result.stdout
        .split("\n")
        .map((line) => /^(.*?):(\d+):(.*)$/.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => ({ path: match[1]!, line: Number(match[2]), text: match[3]! }));
      return { tool: "search", matches, truncated: matches.length >= tool.limit };
    }
    case "apply_patch":
      await run("sh", ["-lc", PATCH_SCRIPT], { stdin: tool.patch });
      return { tool: "apply_patch", files: [] };
    case "glob": {
      const result = await run("sh", [
        "-lc",
        GLOB_SCRIPT,
        "bigbud-glob",
        tool.path,
        tool.pattern,
        String(tool.limit),
      ]);
      const paths = result.stdout.split("\n").filter((line) => line.length > 0);
      return { tool: "glob", paths, truncated: paths.length >= tool.limit };
    }
  }
}
