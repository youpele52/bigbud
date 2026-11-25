import type {
  ProjectFileContentMatch,
  ProjectSearchFileContentsInput,
  ProjectSearchFileContentsResult,
} from "@bigbud/contracts/workspace/project.ts";
import { Cause, Data, Effect, Exit, Schema } from "effect";

import { runToolCommand, resolveToolTransportTarget } from "../../tool-transport/toolTransport.ts";
import { resolveWorkspaceTarget } from "../../workspace-target/workspaceTarget.ts";
import type { WorkspaceContentSearchOwnerShape } from "../Services/WorkspaceContentSearchOwner.ts";
import { WorkspaceFileSystemError } from "../Services/WorkspaceFileSystem.ts";

class WorkspaceSearchCommandError extends Data.TaggedError("WorkspaceSearchCommandError")<{
  readonly detail: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.detail;
  }
}

const REMOTE_SEARCH_OPERATION = "workspaceFileSystem.searchFileContentsRemote";
const SEARCH_COMMAND_OPERATION = "workspaceFileSystem.searchFileContentsCommand";
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

function searchFailure(cwd: string, operation: string, cause: unknown): WorkspaceFileSystemError {
  if (Schema.is(WorkspaceFileSystemError)(cause)) return cause;
  const detail = cause instanceof Error ? cause.message : String(cause);
  const missingRipgrep = detail === "Command not found: rg";
  return new WorkspaceFileSystemError({
    cwd,
    operation: missingRipgrep ? REMOTE_SEARCH_OPERATION : operation,
    detail: missingRipgrep
      ? "Remote content search requires ripgrep on the SSH host, or the bigbud agent."
      : detail,
    cause,
  });
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

export function limitSearchResult(
  result: ProjectSearchFileContentsResult,
  requestedLimit: number,
): ProjectSearchFileContentsResult {
  const limit = Math.max(0, Math.floor(requestedLimit));
  return {
    ...result,
    matches: result.matches.slice(0, limit),
    truncated: result.truncated || result.matches.length > limit,
  };
}

/**
 * Direct-SSH hosts (no managed agent) keep `rg` on the host (plan Q5). Legacy matching is literal
 * and case-insensitive, like the agent's engine, so `a.b(` is text rather than a regular expression.
 */
export const searchRemoteFileContentsViaSsh = Effect.fn("WorkspaceFileSystem.searchRemoteViaSsh")(
  function* (
    input: ProjectSearchFileContentsInput & { executionTargetId: string },
    owner?: WorkspaceContentSearchOwnerShape,
  ) {
    const toolTransportTarget = resolveToolTransportTarget(
      resolveWorkspaceTarget({ executionTargetId: input.executionTargetId, cwd: input.cwd }),
    );
    if (owner && toolTransportTarget.transport === "ssh") {
      const result = yield* Effect.tryPromise({
        try: () => owner.searchFileContents(input),
        catch: (cause) => searchFailure(input.cwd, REMOTE_SEARCH_OPERATION, cause),
      });
      return limitSearchResult(result, input.limit);
    }

    const searchResultOrError = yield* Effect.exit(
      Effect.tryPromise({
        try: () =>
          runToolCommand({
            target: toolTransportTarget,
            command: "rg",
            args: [
              "--json",
              "--hidden",
              "--ignore-case",
              "--fixed-strings",
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
      return yield* searchFailure(input.cwd, SEARCH_COMMAND_OPERATION, failure);
    }

    const searchResult = searchResultOrError.value;
    if (searchResult.code !== 0 && searchResult.code !== 1) {
      return yield* new WorkspaceFileSystemError({
        cwd: input.cwd,
        operation: SEARCH_COMMAND_OPERATION,
        detail: searchResult.stderr.trim() || "Workspace file content search failed.",
      });
    }

    return limitSearchResult(
      {
        matches: parseRipgrepJsonMatches(searchResult.stdout),
        truncated: searchResult.stdoutTruncated ?? false,
        notice: "use-managed-agent",
      },
      input.limit,
    );
  },
);
