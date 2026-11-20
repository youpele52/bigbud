import type {
  ProjectFileContentMatch,
  ProjectSearchFileContentsInput,
  ProjectSearchFileContentsResult,
} from "@bigbud/contracts/workspace/project.ts";
import { Cause, Data, Effect, Exit } from "effect";

import { runToolCommand, resolveToolTransportTarget } from "../../tool-transport/toolTransport.ts";
import { resolveWorkspaceTarget } from "../../workspace-target/workspaceTarget.ts";
import { WorkspaceFileSystemError } from "../Services/WorkspaceFileSystem.ts";

class WorkspaceSearchCommandError extends Data.TaggedError("WorkspaceSearchCommandError")<{
  readonly detail: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.detail;
  }
}

const WORKSPACE_FILE_CONTENT_SEARCH_TIMEOUT_MS = 10_000;
const WORKSPACE_FILE_CONTENT_SEARCH_MAX_BUFFER_BYTES = 512 * 1024;
const WORKSPACE_FILE_CONTENT_SEARCH_IGNORED_GLOBS = [
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

function normalizeMatchedPath(pathValue: string): string {
  return pathValue.replace(/^\.\//, "").replaceAll("\\", "/");
}

function isRipgrepCommandNotFound(error: WorkspaceSearchCommandError): boolean {
  return error.message === "Command not found: rg";
}

function normalizeSearchCommandError(error: unknown): WorkspaceSearchCommandError {
  if (error instanceof WorkspaceSearchCommandError) return error;
  if (error instanceof Error) {
    return new WorkspaceSearchCommandError({ detail: error.message, cause: error });
  }
  return new WorkspaceSearchCommandError({ detail: String(error), cause: error });
}

function parseRipgrepJsonMatches(stdout: string): ProjectFileContentMatch[] {
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

/**
 * Direct-SSH hosts (no managed agent) keep `rg` on the host (plan Q5). Results carry the
 * `use-managed-agent` notice so the client can suggest the faster agent search.
 */
export const searchRemoteFileContentsViaSsh = Effect.fn("WorkspaceFileSystem.searchRemoteViaSsh")(
  function* (input: ProjectSearchFileContentsInput & { readonly executionTargetId: string }) {
    const toolTransportTarget = resolveToolTransportTarget(
      resolveWorkspaceTarget({ executionTargetId: input.executionTargetId, cwd: input.cwd }),
    );
    const searchResultOrError = yield* Effect.exit(
      Effect.tryPromise({
        try: () =>
          runToolCommand({
            target: toolTransportTarget,
            command: "rg",
            args: [
              "--json",
              "--hidden",
              "--smart-case",
              ...WORKSPACE_FILE_CONTENT_SEARCH_IGNORED_GLOBS.flatMap((glob) => ["--glob", glob]),
              "--",
              input.query,
              ".",
            ],
            allowNonZeroExit: true,
            timeoutMs: WORKSPACE_FILE_CONTENT_SEARCH_TIMEOUT_MS,
            maxBufferBytes: WORKSPACE_FILE_CONTENT_SEARCH_MAX_BUFFER_BYTES,
            outputMode: "truncate",
          }),
        catch: normalizeSearchCommandError,
      }),
    );

    if (Exit.isFailure(searchResultOrError)) {
      const failure = normalizeSearchCommandError(Cause.squash(searchResultOrError.cause));
      return yield* new WorkspaceFileSystemError({
        cwd: input.cwd,
        operation: isRipgrepCommandNotFound(failure)
          ? "workspaceFileSystem.searchFileContentsRemote"
          : "workspaceFileSystem.searchFileContentsCommand",
        detail: isRipgrepCommandNotFound(failure)
          ? "Remote content search requires ripgrep on the SSH host, or the bigbud agent."
          : failure.message,
        cause: failure,
      });
    }

    const searchResult = searchResultOrError.value;
    if (searchResult.code !== 0 && searchResult.code !== 1) {
      return yield* new WorkspaceFileSystemError({
        cwd: input.cwd,
        operation: "workspaceFileSystem.searchFileContentsCommand",
        detail: searchResult.stderr.trim() || "Workspace file content search failed.",
      });
    }

    const matches = parseRipgrepJsonMatches(searchResult.stdout);
    const limit = Math.max(0, Math.floor(input.limit));
    return {
      matches: matches.slice(0, limit),
      truncated: (searchResult.stdoutTruncated ?? false) || matches.length > limit,
      notice: "use-managed-agent",
    } satisfies ProjectSearchFileContentsResult;
  },
);
