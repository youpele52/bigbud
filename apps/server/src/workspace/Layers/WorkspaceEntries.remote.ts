import { Effect } from "effect";

import { type ProjectEntry } from "@bigbud/contracts";

import { runSshCommand } from "../../ssh/sshProcess.ts";
import { WorkspaceEntriesError } from "../Services/WorkspaceEntries.ts";
import {
  type SearchableWorkspaceEntry,
  toPosixPath,
  parentPathOf,
  toSearchableWorkspaceEntry,
  isPathInIgnoredDirectory,
  directoryAncestorsOf,
} from "./WorkspaceEntriesSearch.ts";

const REMOTE_WORKSPACE_SCAN_TIMEOUT_MS = 30_000;
const WORKSPACE_INDEX_MAX_ENTRIES = 25_000;
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

export interface RemoteWorkspaceIndex {
  scannedAt: number;
  entries: SearchableWorkspaceEntry[];
  truncated: boolean;
}

const processErrorDetail = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

function splitNullSeparatedOutput(stdout: string, truncated: boolean): string[] {
  const parts = stdout.split("\0");
  if (parts.length === 0) {
    return [];
  }
  if (truncated && parts[parts.length - 1]?.length) {
    parts.pop();
  }
  return parts.filter((value) => value.length > 0);
}

function toRemoteProjectEntries(
  input: ReadonlyArray<{ path: string; kind: "file" | "directory" }>,
): SearchableWorkspaceEntry[] {
  return input
    .filter((entry) => !isPathInIgnoredDirectory(entry.path, IGNORED_DIRECTORY_NAMES))
    .toSorted((left, right) => left.path.localeCompare(right.path))
    .map((entry): ProjectEntry => {
      const parentPath = parentPathOf(entry.path);
      if (parentPath !== undefined) {
        return {
          path: entry.path,
          kind: entry.kind,
          parentPath,
        };
      }
      return {
        path: entry.path,
        kind: entry.kind,
      };
    })
    .map(toSearchableWorkspaceEntry);
}

export const buildRemoteWorkspaceIndex = Effect.fn("buildRemoteWorkspaceIndex")(function* (input: {
  readonly cwd: string;
  readonly executionTargetId: string;
}): Effect.fn.Return<RemoteWorkspaceIndex, WorkspaceEntriesError> {
  const gitProbe = yield* Effect.tryPromise({
    try: () =>
      runSshCommand({
        executionTargetId: input.executionTargetId,
        cwd: input.cwd,
        command: "git",
        args: ["rev-parse", "--is-inside-work-tree"],
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxBufferBytes: 4_096,
        outputMode: "truncate",
      }),
    catch: (cause) =>
      new WorkspaceEntriesError({
        cwd: input.cwd,
        operation: "workspaceEntries.remoteGitProbe",
        detail: processErrorDetail(cause),
        cause,
      }),
  });

  if (gitProbe.code === 0 && gitProbe.stdout.trim() === "true") {
    const listedFiles = yield* Effect.tryPromise({
      try: () =>
        runSshCommand({
          executionTargetId: input.executionTargetId,
          cwd: input.cwd,
          command: "git",
          args: ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
          allowNonZeroExit: true,
          timeoutMs: REMOTE_WORKSPACE_SCAN_TIMEOUT_MS,
          maxBufferBytes: 16 * 1024 * 1024,
          outputMode: "truncate",
        }),
      catch: (cause) =>
        new WorkspaceEntriesError({
          cwd: input.cwd,
          operation: "workspaceEntries.remoteGitLsFiles",
          detail: processErrorDetail(cause),
          cause,
        }),
    });

    if (listedFiles.code === 0) {
      const filePaths = splitNullSeparatedOutput(
        listedFiles.stdout,
        listedFiles.stdoutTruncated ?? false,
      )
        .map((entry) => toPosixPath(entry))
        .filter(
          (entry) => entry.length > 0 && !isPathInIgnoredDirectory(entry, IGNORED_DIRECTORY_NAMES),
        );
      const directorySet = new Set<string>();
      for (const filePath of filePaths) {
        for (const directoryPath of directoryAncestorsOf(filePath)) {
          if (!isPathInIgnoredDirectory(directoryPath, IGNORED_DIRECTORY_NAMES)) {
            directorySet.add(directoryPath);
          }
        }
      }

      const entries = toRemoteProjectEntries([
        ...[...directorySet].map((path) => ({ path, kind: "directory" as const })),
        ...[...new Set(filePaths)].map((path) => ({ path, kind: "file" as const })),
      ]);
      return {
        scannedAt: Date.now(),
        entries: entries.slice(0, WORKSPACE_INDEX_MAX_ENTRIES),
        truncated:
          (listedFiles.stdoutTruncated ?? false) || entries.length > WORKSPACE_INDEX_MAX_ENTRIES,
      };
    }
  }

  const findResult = yield* Effect.tryPromise({
    try: () =>
      runSshCommand({
        executionTargetId: input.executionTargetId,
        cwd: input.cwd,
        command: "find",
        args: [
          ".",
          "(",
          "-name",
          ".git",
          "-o",
          "-name",
          ".convex",
          "-o",
          "-name",
          "node_modules",
          "-o",
          "-name",
          ".next",
          "-o",
          "-name",
          ".turbo",
          "-o",
          "-name",
          "dist",
          "-o",
          "-name",
          "build",
          "-o",
          "-name",
          "out",
          "-o",
          "-name",
          ".cache",
          ")",
          "-prune",
          "-o",
          "-printf",
          "%y\t%P\0",
        ],
        allowNonZeroExit: false,
        timeoutMs: REMOTE_WORKSPACE_SCAN_TIMEOUT_MS,
        maxBufferBytes: 16 * 1024 * 1024,
        outputMode: "truncate",
      }),
    catch: (cause) =>
      new WorkspaceEntriesError({
        cwd: input.cwd,
        operation: "workspaceEntries.remoteFind",
        detail: processErrorDetail(cause),
        cause,
      }),
  });

  const entries = toRemoteProjectEntries(
    splitNullSeparatedOutput(findResult.stdout, findResult.stdoutTruncated ?? false)
      .map((entry) => {
        const [kindRaw = "", pathRaw = ""] = entry.split("\t");
        const normalizedPath = toPosixPath(pathRaw.replace(/^\.\//, "").trim());
        if (!normalizedPath || normalizedPath === ".") {
          return null;
        }
        return {
          path: normalizedPath,
          kind: kindRaw === "d" ? ("directory" as const) : ("file" as const),
        };
      })
      .filter((entry): entry is { path: string; kind: "file" | "directory" } => entry !== null),
  );

  return {
    scannedAt: Date.now(),
    entries: entries.slice(0, WORKSPACE_INDEX_MAX_ENTRIES),
    truncated:
      (findResult.stdoutTruncated ?? false) || entries.length > WORKSPACE_INDEX_MAX_ENTRIES,
  };
});
