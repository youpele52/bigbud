/**
 * Pure helpers for discarding selected working tree changes: request validation, porcelain v2
 * (`-z`) parsing, and resolution of listed paths to the status entries they belong to.
 *
 * @module GitStatus.discard.logic
 */
import type { GitDiscardSelection } from "../Services/GitCore.ts";

export interface GitDiscardEntry {
  readonly kind: "tracked" | "untracked";
  /** Repository-root-relative paths the entry covers (a rename covers both its paths). */
  readonly paths: ReadonlyArray<string>;
}

export type GitDiscardPlan =
  | { readonly ok: true; readonly tracked: string[]; readonly untracked: string[] }
  | { readonly ok: false; readonly detail: string };

const STALE_LIST_DETAIL =
  "The changed files list is out of date. Refresh the Git panel and try again; nothing was discarded.";

/** Accepts only plain repository-relative paths; never absolute, `..`, or control characters. */
export function isSafeRepoRelativePath(value: string): boolean {
  if (value.length === 0 || value.trim() !== value) return false;
  // oxlint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(value)) return false;
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value)) return false;
  return value.split(/[\\/]/).every((segment) => segment !== ".." && segment !== "");
}

/** Literal pathspec relative to the repository root, so globs and cwd never change the target. */
export function toLiteralTopPathspec(relativePath: string): string {
  return `:(top,literal)${relativePath}`;
}

function fieldsAfter(token: string, fieldCount: number): string | null {
  let index = 0;
  for (let field = 0; field < fieldCount; field += 1) {
    index = token.indexOf(" ", index);
    if (index < 0) return null;
    index += 1;
  }
  const rest = token.slice(index);
  return rest.length > 0 ? rest : null;
}

/** Parses `git status --porcelain=2 -z -uall` output. Ignored entries are skipped. */
export function parsePorcelainV2Z(stdout: string): GitDiscardEntry[] {
  const tokens = stdout.split("\0");
  const entries: GitDiscardEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token.startsWith("1 ")) {
      const filePath = fieldsAfter(token, 8);
      if (filePath) entries.push({ kind: "tracked", paths: [filePath] });
    } else if (token.startsWith("2 ")) {
      const filePath = fieldsAfter(token, 9);
      const originalPath = tokens[index + 1] ?? "";
      index += 1;
      if (filePath) {
        entries.push({
          kind: "tracked",
          paths: originalPath ? [filePath, originalPath] : [filePath],
        });
      }
    } else if (token.startsWith("u ")) {
      const filePath = fieldsAfter(token, 10);
      if (filePath) entries.push({ kind: "tracked", paths: [filePath] });
    } else if (token.startsWith("? ")) {
      const filePath = token.slice(2);
      if (filePath) entries.push({ kind: "untracked", paths: [filePath] });
    }
  }
  return entries;
}

/**
 * Checks the request against the list the panel currently shows (`listedPaths`) and resolves it to
 * concrete status entries. Any mismatch refuses the whole request before anything is changed.
 */
export function planGitDiscard(input: {
  readonly selection: GitDiscardSelection;
  readonly listedPaths: ReadonlyArray<string>;
  readonly entries: ReadonlyArray<GitDiscardEntry>;
}): GitDiscardPlan {
  const requested = [...new Set(input.selection.paths)];
  if (requested.length === 0) return { ok: false, detail: "No files were selected to discard." };
  const unsafe = requested.find((value) => !isSafeRepoRelativePath(value));
  if (unsafe !== undefined) {
    return { ok: false, detail: `Refusing to discard a path outside the repository: ${unsafe}` };
  }
  const listed = new Set(input.listedPaths);
  if (requested.some((value) => !listed.has(value)))
    return { ok: false, detail: STALE_LIST_DETAIL };
  if (input.selection.scope === "all" && listed.size !== requested.length) {
    return { ok: false, detail: STALE_LIST_DETAIL };
  }

  const selected = new Set<GitDiscardEntry>();
  for (const value of requested) {
    const matches = input.entries.filter((entry) => entry.paths.includes(value));
    if (matches.length === 0) {
      return {
        ok: false,
        detail: `Could not match ${value} to a current change; nothing was discarded.`,
      };
    }
    for (const entry of matches) selected.add(entry);
  }

  const tracked = new Set<string>();
  const untracked = new Set<string>();
  for (const entry of selected) {
    if (entry.paths.some((value) => !isSafeRepoRelativePath(value))) {
      return { ok: false, detail: `Refusing to discard an unexpected path: ${entry.paths[0]}` };
    }
    for (const value of entry.paths) (entry.kind === "tracked" ? tracked : untracked).add(value);
  }
  return { ok: true, tracked: [...tracked], untracked: [...untracked] };
}
