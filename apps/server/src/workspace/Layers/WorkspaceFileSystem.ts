import { Duration, Effect, FileSystem, Layer, Path, Stream } from "effect";
import { resolveExecutionTargetId, type ProjectFileContentMatch } from "@bigbud/contracts";
import { open, stat } from "node:fs/promises";

import {
  WorkspaceFileSystem,
  WorkspaceFileSystemError,
  type WorkspaceFileSystemShape,
} from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";
import { isLocalExecutionTarget } from "../../executionTargets.ts";
import { runToolCommand, resolveToolTransportTarget } from "../../tool-transport/toolTransport.ts";
import { resolveWorkspaceTarget } from "../../workspace-target/workspaceTarget.ts";

const DEFAULT_FILE_PREVIEW_MAX_BYTES = 512 * 1024;
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

async function readTextFilePreview(
  absolutePath: string,
  maxBytes: number,
): Promise<{ contents: string; sizeBytes: number; truncated: boolean }> {
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) {
    throw new Error("Workspace preview target is not a file.");
  }

  const bytesToRead = Math.min(fileStat.size, maxBytes);
  const buffer = Buffer.alloc(bytesToRead);
  const fileHandle = await open(absolutePath, "r");
  try {
    const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) {
      throw new Error("Binary files cannot be previewed.");
    }
    return {
      contents: new TextDecoder("utf-8").decode(bytes),
      sizeBytes: fileStat.size,
      truncated: fileStat.size > maxBytes,
    };
  } finally {
    await fileHandle.close();
  }
}

function normalizeMatchedPath(pathValue: string): string {
  return pathValue.replace(/^\.\//, "").replaceAll("\\", "/");
}

function parseRipgrepJsonMatches(stdout: string): ProjectFileContentMatch[] {
  const matches: ProjectFileContentMatch[] = [];

  for (const rawLine of stdout.split(/\r?\n/g)) {
    if (!rawLine.trim()) {
      continue;
    }

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
    if (typeof data !== "object" || data === null) {
      continue;
    }

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

    if (!pathText || line <= 0) {
      continue;
    }

    matches.push({
      path: pathText,
      line,
      ...(columnValue !== undefined ? { column: columnValue } : {}),
      lineText,
    });
  }

  return matches;
}

export const makeWorkspaceFileSystem = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;

  const readFilePreview: WorkspaceFileSystemShape["readFilePreview"] = Effect.fn(
    "WorkspaceFileSystem.readFilePreview",
  )(function* (input) {
    const executionTargetId = resolveExecutionTargetId(input.executionTargetId);
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    if (!isLocalExecutionTarget(executionTargetId)) {
      return yield* new WorkspaceFileSystemError({
        cwd: input.cwd,
        relativePath: input.relativePath,
        operation: "workspaceFileSystem.readFilePreviewRemote",
        detail: "Remote workspace file preview is not supported yet.",
      });
    }

    const preview = yield* Effect.tryPromise({
      try: () =>
        readTextFilePreview(target.absolutePath, input.maxBytes ?? DEFAULT_FILE_PREVIEW_MAX_BYTES),
      catch: (cause) =>
        new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.readFilePreview",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });

    return { relativePath: target.relativePath, ...preview };
  });

  const searchFileContents: WorkspaceFileSystemShape["searchFileContents"] = Effect.fn(
    "WorkspaceFileSystem.searchFileContents",
  )(function* (input) {
    const executionTargetId = resolveExecutionTargetId(input.executionTargetId);
    const normalizedWorkspaceRoot = yield* workspacePaths.normalizeWorkspaceRoot(input.cwd).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            operation: "workspaceFileSystem.searchFileContents",
            detail: cause.message,
            cause,
          }),
      ),
    );

    if (!isLocalExecutionTarget(executionTargetId)) {
      return yield* new WorkspaceFileSystemError({
        cwd: input.cwd,
        operation: "workspaceFileSystem.searchFileContentsRemote",
        detail: "Remote workspace file content search is not supported yet.",
      });
    }

    const workspaceTarget = resolveWorkspaceTarget({
      executionTargetId,
      cwd: normalizedWorkspaceRoot,
    });
    const toolTransportTarget = resolveToolTransportTarget(workspaceTarget);
    const searchResult = yield* Effect.tryPromise({
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
      catch: (cause) =>
        new WorkspaceFileSystemError({
          cwd: input.cwd,
          operation: "workspaceFileSystem.searchFileContentsCommand",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });

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
    };
  });

  const watchDirectory: WorkspaceFileSystemShape["watchDirectory"] = Effect.fn(
    "WorkspaceFileSystem.watchDirectory",
  )(function* (input) {
    const executionTargetId = resolveExecutionTargetId(input.executionTargetId);
    const normalizedWorkspaceRoot = yield* workspacePaths.normalizeWorkspaceRoot(input.cwd).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.watchDirectory",
            detail: cause.message,
            cause,
          }),
      ),
    );
    const target = input.relativePath
      ? yield* workspacePaths.resolveRelativePathWithinRoot({
          workspaceRoot: normalizedWorkspaceRoot,
          relativePath: input.relativePath,
        })
      : {
          absolutePath: normalizedWorkspaceRoot,
          relativePath: "",
        };

    if (!isLocalExecutionTarget(executionTargetId)) {
      return yield* new WorkspaceFileSystemError({
        cwd: input.cwd,
        relativePath: input.relativePath,
        operation: "workspaceFileSystem.watchDirectoryRemote",
        detail: "Remote workspace directory watching is not supported yet.",
      });
    }

    return fileSystem.watch(target.absolutePath).pipe(
      Stream.debounce(Duration.millis(100)),
      Stream.map(() => ({
        version: 1 as const,
        type: "directoryChanged" as const,
        relativePath: target.relativePath,
      })),
      Stream.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: target.relativePath,
            operation: "workspaceFileSystem.watchDirectory",
            detail: cause.message,
            cause,
          }),
      ),
    );
  });

  const writeFile: WorkspaceFileSystemShape["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const workspaceTarget = resolveWorkspaceTarget({
      executionTargetId: input.executionTargetId,
      cwd: input.cwd,
    });
    const toolTransportTarget = resolveToolTransportTarget(workspaceTarget);
    const executionTargetId = resolveExecutionTargetId(input.executionTargetId);
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    if (!isLocalExecutionTarget(executionTargetId)) {
      yield* Effect.tryPromise({
        try: () =>
          runToolCommand({
            target: toolTransportTarget,
            command: "sh",
            args: ["-lc", 'mkdir -p "$(dirname -- "$1")" && cat > "$1"', "sh", target.relativePath],
            stdin: input.contents,
            timeoutMs: 30_000,
            maxBufferBytes: 256 * 1024,
            outputMode: "truncate",
          }),
        catch: (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.writeFileRemote",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
      yield* workspaceEntries.invalidate(input.cwd);
      return { relativePath: target.relativePath };
    }

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.makeDirectory",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFileString(target.absolutePath, input.contents).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.writeFile",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* workspaceEntries.invalidate(input.cwd);
    return { relativePath: target.relativePath };
  });
  return {
    readFilePreview,
    searchFileContents,
    watchDirectory,
    writeFile,
  } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);
