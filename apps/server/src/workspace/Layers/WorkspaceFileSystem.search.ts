import fsPromises from "node:fs/promises";
import path from "node:path";

import type { ProjectFileContentMatch } from "@bigbud/contracts";
import { Data } from "effect";

export class WorkspaceSearchCommandError extends Data.TaggedError("WorkspaceSearchCommandError")<{
  readonly detail: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.detail;
  }
}

export const WORKSPACE_FILE_CONTENT_SEARCH_TIMEOUT_MS = 10_000;
export const WORKSPACE_FILE_CONTENT_SEARCH_MAX_BUFFER_BYTES = 512 * 1024;
export const WORKSPACE_FILE_CONTENT_SEARCH_IGNORED_GLOBS = [
  "!**/.git/**",
  "!**/.convex/**",
  "!**/node_modules/**",
  "!**/.next/**",
  "!**/.turbo/**",
  "!**/dist/**",
  "!**/build/**",
  "!**/out/**",
  "!**/.cache/**",
];

const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".convex",
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "out",
  ".cache",
]);

function normalizeMatchedPath(pathValue: string): string {
  return pathValue.replace(/^\.\//, "").replaceAll("\\", "/");
}

export function isRipgrepCommandNotFound(error: WorkspaceSearchCommandError): boolean {
  return error.message === "Command not found: rg";
}

export function normalizeSearchCommandError(error: unknown): WorkspaceSearchCommandError {
  if (error instanceof WorkspaceSearchCommandError) return error;
  if (error instanceof Error) {
    return new WorkspaceSearchCommandError({ detail: error.message, cause: error });
  }
  return new WorkspaceSearchCommandError({ detail: String(error), cause: error });
}

export function parseRipgrepJsonMatches(stdout: string): ProjectFileContentMatch[] {
  const matches: ProjectFileContentMatch[] = [];

  for (const rawLine of stdout.split(/\r?\n/g)) {
    if (!rawLine.trim()) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      continue;
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("type" in parsed) ||
      parsed.type !== "match" ||
      !("data" in parsed)
    ) {
      continue;
    }

    const data = parsed.data;
    if (typeof data !== "object" || data === null) continue;

    const pathText =
      "path" in data &&
      typeof data.path === "object" &&
      data.path !== null &&
      "text" in data.path &&
      typeof data.path.text === "string"
        ? normalizeMatchedPath(data.path.text)
        : "";
    const line =
      "line_number" in data && typeof data.line_number === "number" ? data.line_number : 0;
    const lineText =
      "lines" in data &&
      typeof data.lines === "object" &&
      data.lines !== null &&
      "text" in data.lines &&
      typeof data.lines.text === "string"
        ? data.lines.text.replace(/\r?\n$/, "")
        : "";
    const column =
      "submatches" in data && Array.isArray(data.submatches) && data.submatches.length > 0
        ? data.submatches[0]
        : null;
    const columnValue =
      column && typeof column === "object" && "start" in column && typeof column.start === "number"
        ? column.start + 1
        : undefined;

    if (!pathText || line <= 0) continue;

    matches.push({
      path: pathText,
      line,
      ...(columnValue !== undefined ? { column: columnValue } : {}),
      lineText,
    });
  }

  return matches;
}

export async function searchFileContentsWithoutRipgrep(input: {
  cwd: string;
  query: string;
  limit: number;
}): Promise<{ matches: ProjectFileContentMatch[]; truncated: boolean }> {
  const normalizedLimit = Math.max(0, Math.floor(input.limit));
  const maxMatches = normalizedLimit + 1;
  const caseSensitive = /[A-Z]/.test(input.query);
  const queryNeedle = caseSensitive ? input.query : input.query.toLowerCase();
  const pendingDirectories = [input.cwd];
  const matches: ProjectFileContentMatch[] = [];

  while (pendingDirectories.length > 0 && matches.length <= normalizedLimit) {
    const currentDirectory = pendingDirectories.shift();
    if (!currentDirectory) continue;

    let dirents;
    try {
      dirents = await fsPromises.readdir(currentDirectory, { withFileTypes: true });
    } catch {
      continue;
    }

    dirents.sort((left, right) => left.name.localeCompare(right.name));

    for (const dirent of dirents) {
      if (dirent.isDirectory()) {
        if (!IGNORED_DIRECTORY_NAMES.has(dirent.name)) {
          pendingDirectories.push(path.join(currentDirectory, dirent.name));
        }
        continue;
      }

      if (!dirent.isFile()) continue;

      const absolutePath = path.join(currentDirectory, dirent.name);
      let contents: Buffer;
      try {
        contents = await fsPromises.readFile(absolutePath);
      } catch {
        continue;
      }

      if (contents.includes(0)) continue;

      const relativePath = normalizeMatchedPath(path.relative(input.cwd, absolutePath));
      const lines = contents.toString("utf8").split(/\r?\n/g);

      for (const [index, lineText] of lines.entries()) {
        const haystack = caseSensitive ? lineText : lineText.toLowerCase();
        const column = haystack.indexOf(queryNeedle);
        if (column === -1) continue;

        matches.push({
          path: relativePath,
          line: index + 1,
          column: column + 1,
          lineText,
        });

        if (matches.length >= maxMatches) {
          return {
            matches: matches.slice(0, normalizedLimit),
            truncated: true,
          };
        }
      }
    }
  }

  return {
    matches,
    truncated: false,
  };
}
