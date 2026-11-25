import { parseRemoteFindRecord } from "./WorkspaceEntries.remote.records.ts";
import { Effect } from "effect";

import { type ProjectEntry } from "@bigbud/contracts";

import { resolveRemoteAgentTransport } from "../../remote-agent/remoteAgentDefault.ts";
import { parseSshExecutionTarget } from "../../ssh/sshExecutionTarget.ts";
import { runSshCommand } from "../../ssh/sshProcess.ts";
import type { WorkspaceDirectoryReadOwnerShape } from "../Services/WorkspaceDirectoryReadOwner.ts";
import { WorkspaceEntriesError } from "../Services/WorkspaceEntries.ts";
import type { WorkspaceIndexReadOwnerShape } from "../Services/WorkspaceIndexReadOwner.ts";
import {
  IGNORED_DIRECTORY_NAMES,
  processErrorDetail,
  WORKSPACE_INDEX_MAX_ENTRIES,
} from "./WorkspaceEntries.constants.ts";
import {
  type SearchableWorkspaceEntry,
  toPosixPath,
  parentPathOf,
  toSearchableWorkspaceEntry,
  isPathInIgnoredDirectory,
  directoryAncestorsOf,
} from "./WorkspaceEntriesSearch.ts";

const REMOTE_WORKSPACE_SCAN_TIMEOUT_MS = 30_000;
const REMOTE_DIRECTORY_LIST_TIMEOUT_MS = 10_000;
const REMOTE_DIRECTORY_LIST_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const isDirectSshWorkspaceTarget = (executionTargetId: string): boolean =>
  parseSshExecutionTarget(executionTargetId) !== null &&
  resolveRemoteAgentTransport(executionTargetId) === "direct-ssh";

export interface RemoteWorkspaceIndex {
  scannedAt: number;
  entries: SearchableWorkspaceEntry[];
  truncated: boolean;
}

export function listRemoteWorkspaceDirectory(
  entries: ReadonlyArray<SearchableWorkspaceEntry>,
  relativeDir: string,
): ProjectEntry[] {
  const normalizedRelativeDir = toPosixPath(relativeDir).replace(/^\.\//, "").replace(/\/$/, "");
  return entries
    .filter((entry) => (entry.parentPath ?? "") === normalizedRelativeDir)
    .map((entry): ProjectEntry => {
      if (entry.parentPath === undefined) {
        return { path: entry.path, kind: entry.kind };
      }
      return { path: entry.path, kind: entry.kind, parentPath: entry.parentPath };
    })
    .toSorted((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === "directory" ? -1 : 1;
      }
      return left.path.localeCompare(right.path);
    });
}

function normalizeRemoteRelativeDirectory(relativeDir: string): string {
  const normalized = toPosixPath(relativeDir);
  if (normalized.includes("\u0000") || normalized.startsWith("/")) {
    throw new Error("Remote workspace directory must stay within the workspace root.");
  }

  const segments = normalized.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.some((segment) => segment === "..")) {
    throw new Error("Remote workspace directory must stay within the workspace root.");
  }
  return segments.join("/");
}

export const listRemoteWorkspaceDirectoryFromSsh = Effect.fn("listRemoteWorkspaceDirectoryFromSsh")(
  function* (
    input: {
      readonly cwd: string;
      readonly executionTargetId: string;
      readonly relativeDir: string;
    },
    directoryReadOwner?: WorkspaceDirectoryReadOwnerShape,
  ): Effect.fn.Return<ReadonlyArray<ProjectEntry>, WorkspaceEntriesError> {
    const relativeDir = yield* Effect.try({
      try: () => normalizeRemoteRelativeDirectory(input.relativeDir),
      catch: (cause) =>
        new WorkspaceEntriesError({
          cwd: input.cwd,
          operation: "workspaceEntries.remoteDirectoryPath",
          detail: processErrorDetail(cause),
          cause,
        }),
    });
    const children = yield* Effect.tryPromise({
      try: async () => {
        if (directoryReadOwner && isDirectSshWorkspaceTarget(input.executionTargetId)) {
          // The public directory listing has no truncation field, just as for the legacy read.
          const { entries } = await directoryReadOwner.listDirectory({ ...input, relativeDir });
          return entries.map(({ name, directory }) =>
            name && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\0")
              ? { path: name, kind: directory ? ("directory" as const) : ("file" as const) }
              : null,
          );
        }

        const findRoot = relativeDir.length > 0 ? `./${relativeDir}` : ".";
        const result = await runSshCommand({
          executionTargetId: input.executionTargetId,
          cwd: input.cwd,
          command: "find",
          args: [
            findRoot,
            "-mindepth",
            "1",
            "-maxdepth",
            "1",
            "(",
            "-type",
            "d",
            "-o",
            "-type",
            "f",
            ")",
            "-printf",
            "%y\\t%P\\0",
          ],
          allowNonZeroExit: false,
          timeoutMs: REMOTE_DIRECTORY_LIST_TIMEOUT_MS,
          maxBufferBytes: REMOTE_DIRECTORY_LIST_MAX_BUFFER_BYTES,
          outputMode: "truncate",
        });
        return splitNullSeparatedOutput(result.stdout, result.stdoutTruncated ?? false).map(
          parseRemoteFindRecord,
        );
      },
      catch: (cause) =>
        new WorkspaceEntriesError({
          cwd: input.cwd,
          operation: "workspaceEntries.remoteDirectory",
          detail: processErrorDetail(cause),
          cause,
        }),
    });

    const entries: Array<{ path: string; kind: "file" | "directory" }> = [];
    for (const child of children) {
      if (child) {
        entries.push({
          path: relativeDir ? `${relativeDir}/${child.path}` : child.path,
          kind: child.kind,
        });
      }
    }

    return listRemoteWorkspaceDirectory(toRemoteProjectEntries(entries), relativeDir);
  },
);

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

function isWorkspaceIndexPath(path: string): boolean {
  // Keep literal POSIX names, but reject paths that can escape or alias the root.
  return (
    typeof path === "string" &&
    !path.includes("\0") &&
    !/^[a-z]:/i.test(path) &&
    toPosixPath(path)
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

export const buildOwnedRemoteWorkspaceIndex = (
  input: { readonly cwd: string; readonly executionTargetId: string },
  owner: WorkspaceIndexReadOwnerShape,
) =>
  Effect.tryPromise({
    try: async () => {
      const index = await owner.indexWorkspace(input);
      const entries = toRemoteProjectEntries(
        index.entries.flatMap(({ path, directory }) =>
          isWorkspaceIndexPath(path) && typeof directory === "boolean"
            ? [{ path, kind: directory ? ("directory" as const) : ("file" as const) }]
            : [],
        ),
      );
      return {
        scannedAt: Date.now(),
        entries: entries.slice(0, WORKSPACE_INDEX_MAX_ENTRIES),
        truncated: index.truncated || entries.length > WORKSPACE_INDEX_MAX_ENTRIES,
      };
    },
    catch: (cause) =>
      new WorkspaceEntriesError({
        cwd: input.cwd,
        operation: "workspaceEntries.remoteIndex",
        detail: processErrorDetail(cause),
        cause,
      }),
  });

export const buildRemoteWorkspaceIndex = Effect.fn("buildRemoteWorkspaceIndex")(function* (
  input: { readonly cwd: string; readonly executionTargetId: string },
  indexReadOwner?: WorkspaceIndexReadOwnerShape,
): Effect.fn.Return<RemoteWorkspaceIndex, WorkspaceEntriesError> {
  if (indexReadOwner && isDirectSshWorkspaceTarget(input.executionTargetId))
    return yield* buildOwnedRemoteWorkspaceIndex(input, indexReadOwner);

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
          "%y\\t%P\\0",
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
        const record = parseRemoteFindRecord(entry);
        if (!record) return null;
        const { path: normalizedPath, kind } = record;
        if (!normalizedPath || normalizedPath === ".") {
          return null;
        }
        return {
          path: normalizedPath,
          kind,
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
