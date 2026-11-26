import { Effect } from "effect";

import { type ProjectEntry } from "@bigbud/contracts";

import { resolveRemoteAgentTransport } from "../../remote-agent/remoteAgentDefault.ts";
import { parseSshExecutionTarget } from "../../ssh/sshExecutionTarget.ts";
import { SshOwnerRequiredError } from "../../ssh/sshOwnerRequired.ts";
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
} from "./WorkspaceEntriesSearch.ts";

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

        // A direct SSH listing runs only through the owner's directory read.
        throw new SshOwnerRequiredError();
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

  return yield* new WorkspaceEntriesError({
    cwd: input.cwd,
    operation: "workspaceEntries.remoteIndex",
    detail: new SshOwnerRequiredError().message,
  });
});
