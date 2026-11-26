/**
 * Minimal unified-diff application for the typed `apply_patch` bridge tool on
 * the SSH owner path. Each file is read, patched in memory and written through
 * the owner's typed verbs; a hunk whose context does not match is a refusal and
 * nothing for that patch is written. Supports `a/`/`b/` (git) and bare paths,
 * new files (`/dev/null` source) and deletions (`/dev/null` target).
 *
 * @module http.threadTools.remoteWorkspacePatch
 */
export interface PatchHunk {
  readonly oldStart: number;
  readonly lines: ReadonlyArray<{ readonly kind: " " | "-" | "+"; readonly text: string }>;
  readonly noNewlineAtEnd: boolean;
}

export interface FilePatch {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly hunks: ReadonlyArray<PatchHunk>;
}

export class PatchApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchApplyError";
  }
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripPath(raw: string): string | null {
  const path = raw.split("\t")[0]!.trim();
  if (path === "/dev/null") return null;
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

export function parseUnifiedPatch(patch: string): ReadonlyArray<FilePatch> {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const files: FilePatch[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.startsWith("--- ") || !lines[index + 1]?.startsWith("+++ ")) {
      index += 1;
      continue;
    }
    const oldPath = stripPath(line.slice(4));
    const newPath = stripPath(lines[index + 1]!.slice(4));
    index += 2;
    const hunks: PatchHunk[] = [];
    while (index < lines.length && HUNK.test(lines[index]!)) {
      const oldStart = Number(HUNK.exec(lines[index]!)![1]);
      index += 1;
      const body: Array<{ kind: " " | "-" | "+"; text: string }> = [];
      let noNewlineAtEnd = false;
      while (index < lines.length) {
        const current = lines[index]!;
        if (current.startsWith("\\")) {
          noNewlineAtEnd = true;
        } else if (current.startsWith(" ") || current.startsWith("-") || current.startsWith("+")) {
          if (current.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) break;
          body.push({ kind: current[0] as " " | "-" | "+", text: current.slice(1) });
        } else if (current === "" && index < lines.length - 1 && !HUNK.test(lines[index + 1]!)) {
          body.push({ kind: " ", text: "" });
        } else break;
        index += 1;
      }
      hunks.push({ oldStart, lines: body, noNewlineAtEnd });
    }
    if (hunks.length === 0) throw new PatchApplyError("The patch has a file header without hunks.");
    files.push({ oldPath, newPath, hunks });
  }
  if (files.length === 0) throw new PatchApplyError("No unified diff file sections were found.");
  return files;
}

/** Apply hunks in order; each must match exactly near its stated line. */
export function applyFilePatch(original: string, file: FilePatch): string {
  const hadTrailingNewline = original.endsWith("\n");
  const source = original === "" ? [] : original.replace(/\n$/, "").split("\n");
  const output: string[] = [];
  let cursor = 0;
  let noNewline = false;
  for (const hunk of file.hunks) {
    const before = hunk.lines.filter((line) => line.kind !== "+").map((line) => line.text);
    const after = hunk.lines.filter((line) => line.kind !== "-").map((line) => line.text);
    const expected = Math.max(0, hunk.oldStart - 1);
    const matches = (at: number) =>
      at >= cursor && before.every((text, offset) => source[at + offset] === text);
    let at = -1;
    for (let delta = 0; delta <= source.length; delta += 1) {
      if (matches(expected - delta)) {
        at = expected - delta;
        break;
      }
      if (matches(expected + delta)) {
        at = expected + delta;
        break;
      }
    }
    if (at < 0)
      throw new PatchApplyError(`A hunk does not apply to ${file.newPath ?? file.oldPath}.`);
    output.push(...source.slice(cursor, at), ...after);
    cursor = at + before.length;
    noNewline = hunk.noNewlineAtEnd;
  }
  output.push(...source.slice(cursor));
  if (output.length === 0) return "";
  const endsWithNewline = cursor >= source.length ? !noNewline : hadTrailingNewline;
  return `${output.join("\n")}${endsWithNewline ? "\n" : ""}`;
}
