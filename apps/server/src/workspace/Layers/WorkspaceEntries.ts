import fsPromises from "node:fs/promises";
import type { Dirent } from "node:fs";

import { Cache, Duration, Effect, Exit, Layer, Option, Path } from "effect";

import { resolveExecutionTargetId, type ProjectEntry } from "@bigbud/contracts";

import { GitCore } from "../../git/Services/GitCore.ts";
import {
  WorkspaceEntries,
  WorkspaceEntriesError,
  type WorkspaceEntriesShape,
} from "../Services/WorkspaceEntries.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";
import {
  type SearchableWorkspaceEntry,
  type RankedWorkspaceEntry,
  toPosixPath,
  parentPathOf,
  toSearchableWorkspaceEntry,
  normalizeQuery,
  isPathInIgnoredDirectory,
  directoryAncestorsOf,
  scoreEntry,
  insertRankedEntry,
} from "./WorkspaceEntriesSearch.ts";
import { isLocalExecutionTarget } from "../../executionTargets.ts";
import { buildRemoteWorkspaceIndex } from "./WorkspaceEntries.remote.ts";

const WORKSPACE_CACHE_TTL_MS = 15_000;
const WORKSPACE_CACHE_MAX_KEYS = 4;
const WORKSPACE_INDEX_MAX_ENTRIES = 25_000;
const WORKSPACE_SCAN_READDIR_CONCURRENCY = 32;
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

interface WorkspaceIndex {
  scannedAt: number;
  entries: SearchableWorkspaceEntry[];
  truncated: boolean;
}

const processErrorDetail = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const makeWorkspaceEntries = Effect.gen(function* () {
  const path = yield* Path.Path;
  const gitOption = yield* Effect.serviceOption(GitCore);
  const workspacePaths = yield* WorkspacePaths;

  const isInsideGitWorkTree = (cwd: string): Effect.Effect<boolean> =>
    Option.match(gitOption, {
      onSome: (git) => git.isInsideWorkTree(cwd).pipe(Effect.catch(() => Effect.succeed(false))),
      onNone: () => Effect.succeed(false),
    });

  const filterGitIgnoredPaths = (
    cwd: string,
    relativePaths: string[],
  ): Effect.Effect<string[], never> =>
    Option.match(gitOption, {
      onSome: (git) =>
        git.filterIgnoredPaths(cwd, relativePaths).pipe(
          Effect.map((paths) => [...paths]),
          Effect.catch(() => Effect.succeed(relativePaths)),
        ),
      onNone: () => Effect.succeed(relativePaths),
    });

  const buildWorkspaceIndexFromGit = Effect.fn("WorkspaceEntries.buildWorkspaceIndexFromGit")(
    function* (cwd: string) {
      if (Option.isNone(gitOption)) {
        return null;
      }
      if (!(yield* isInsideGitWorkTree(cwd))) {
        return null;
      }

      const listedFiles = yield* gitOption.value
        .listWorkspaceFiles(cwd)
        .pipe(Effect.catch(() => Effect.succeed(null)));

      if (!listedFiles) {
        return null;
      }

      const listedPaths = [...listedFiles.paths]
        .map((entry) => toPosixPath(entry))
        .filter(
          (entry) => entry.length > 0 && !isPathInIgnoredDirectory(entry, IGNORED_DIRECTORY_NAMES),
        );
      const filePaths = yield* filterGitIgnoredPaths(cwd, listedPaths);

      const directorySet = new Set<string>();
      for (const filePath of filePaths) {
        for (const directoryPath of directoryAncestorsOf(filePath)) {
          if (!isPathInIgnoredDirectory(directoryPath, IGNORED_DIRECTORY_NAMES)) {
            directorySet.add(directoryPath);
          }
        }
      }

      const directoryEntries = [...directorySet]
        .toSorted((left, right) => left.localeCompare(right))
        // oxlint-disable-next-line no-map-spread -- copy-on-write required; parentPath is optional
        .map((directoryPath): ProjectEntry => {
          const parentPath = parentPathOf(directoryPath);
          return {
            path: directoryPath,
            kind: "directory",
            ...(parentPath !== undefined ? { parentPath } : {}),
          };
        })
        .map(toSearchableWorkspaceEntry);
      const fileEntries = [...new Set(filePaths)]
        .toSorted((left, right) => left.localeCompare(right))
        // oxlint-disable-next-line no-map-spread -- copy-on-write required; parentPath is optional
        .map((filePath): ProjectEntry => {
          const parentPath = parentPathOf(filePath);
          return {
            path: filePath,
            kind: "file",
            ...(parentPath !== undefined ? { parentPath } : {}),
          };
        })
        .map(toSearchableWorkspaceEntry);

      const entries = [...directoryEntries, ...fileEntries];
      return {
        scannedAt: Date.now(),
        entries: entries.slice(0, WORKSPACE_INDEX_MAX_ENTRIES),
        truncated: listedFiles.truncated || entries.length > WORKSPACE_INDEX_MAX_ENTRIES,
      };
    },
  );

  const readDirectoryEntries = Effect.fn("WorkspaceEntries.readDirectoryEntries")(function* (
    cwd: string,
    relativeDir: string,
  ): Effect.fn.Return<
    { readonly relativeDir: string; readonly dirents: Dirent[] | null },
    WorkspaceEntriesError
  > {
    return yield* Effect.tryPromise({
      try: async () => {
        const absoluteDir = relativeDir ? path.join(cwd, relativeDir) : cwd;
        const dirents = await fsPromises.readdir(absoluteDir, { withFileTypes: true });
        return { relativeDir, dirents };
      },
      catch: (cause) =>
        new WorkspaceEntriesError({
          cwd,
          operation: "workspaceEntries.readDirectoryEntries",
          detail: processErrorDetail(cause),
          cause,
        }),
    }).pipe(
      Effect.catchIf(
        () => relativeDir.length > 0,
        () => Effect.succeed({ relativeDir, dirents: null }),
      ),
    );
  });

  const buildWorkspaceIndexFromFilesystem = Effect.fn(
    "WorkspaceEntries.buildWorkspaceIndexFromFilesystem",
  )(function* (cwd: string): Effect.fn.Return<WorkspaceIndex, WorkspaceEntriesError> {
    const shouldFilterWithGitIgnore = yield* isInsideGitWorkTree(cwd);

    let pendingDirectories: string[] = [""];
    const entries: SearchableWorkspaceEntry[] = [];
    let truncated = false;

    while (pendingDirectories.length > 0 && !truncated) {
      const currentDirectories = pendingDirectories;
      pendingDirectories = [];

      const directoryEntries = yield* Effect.forEach(
        currentDirectories,
        (relativeDir) => readDirectoryEntries(cwd, relativeDir),
        { concurrency: WORKSPACE_SCAN_READDIR_CONCURRENCY },
      );

      const candidateEntriesByDirectory = directoryEntries.map((directoryEntry) => {
        const { relativeDir, dirents } = directoryEntry;
        if (!dirents) return [] as Array<{ dirent: Dirent; relativePath: string }>;

        dirents.sort((left, right) => left.name.localeCompare(right.name));
        const candidates: Array<{ dirent: Dirent; relativePath: string }> = [];
        for (const dirent of dirents) {
          if (!dirent.name || dirent.name === "." || dirent.name === "..") {
            continue;
          }
          if (dirent.isDirectory() && IGNORED_DIRECTORY_NAMES.has(dirent.name)) {
            continue;
          }
          if (!dirent.isDirectory() && !dirent.isFile()) {
            continue;
          }

          const relativePath = toPosixPath(
            relativeDir ? path.join(relativeDir, dirent.name) : dirent.name,
          );
          if (isPathInIgnoredDirectory(relativePath, IGNORED_DIRECTORY_NAMES)) {
            continue;
          }
          candidates.push({ dirent, relativePath });
        }
        return candidates;
      });

      const candidatePaths = candidateEntriesByDirectory.flatMap((candidateEntries) =>
        candidateEntries.map((entry) => entry.relativePath),
      );
      const allowedPathSet = shouldFilterWithGitIgnore
        ? new Set(yield* filterGitIgnoredPaths(cwd, candidatePaths))
        : null;

      for (const candidateEntries of candidateEntriesByDirectory) {
        for (const candidate of candidateEntries) {
          if (allowedPathSet && !allowedPathSet.has(candidate.relativePath)) {
            continue;
          }

          const parentPath = parentPathOf(candidate.relativePath);
          const entry = toSearchableWorkspaceEntry({
            path: candidate.relativePath,
            kind: candidate.dirent.isDirectory() ? "directory" : "file",
            ...(parentPath !== undefined ? { parentPath } : {}),
          });
          entries.push(entry);

          if (candidate.dirent.isDirectory()) {
            pendingDirectories.push(candidate.relativePath);
          }

          if (entries.length >= WORKSPACE_INDEX_MAX_ENTRIES) {
            truncated = true;
            break;
          }
        }

        if (truncated) {
          break;
        }
      }
    }

    return {
      scannedAt: Date.now(),
      entries,
      truncated,
    };
  });

  const buildWorkspaceIndex = Effect.fn("WorkspaceEntries.buildWorkspaceIndex")(function* (
    cacheKey: string,
  ): Effect.fn.Return<WorkspaceIndex, WorkspaceEntriesError> {
    const [executionTargetId, cwd] = cacheKey.split("\u0000");
    if (cwd === undefined || !executionTargetId) {
      return yield* new WorkspaceEntriesError({
        cwd: cacheKey,
        operation: "workspaceEntries.cacheKey",
        detail: "Invalid workspace cache key.",
      });
    }
    if (!isLocalExecutionTarget(executionTargetId)) {
      return yield* buildRemoteWorkspaceIndex({
        cwd,
        executionTargetId,
      });
    }

    const gitIndexed = yield* buildWorkspaceIndexFromGit(cwd);
    if (gitIndexed) {
      return gitIndexed;
    }
    return yield* buildWorkspaceIndexFromFilesystem(cwd);
  });

  const workspaceIndexCache = yield* Cache.makeWith<string, WorkspaceIndex, WorkspaceEntriesError>({
    capacity: WORKSPACE_CACHE_MAX_KEYS,
    lookup: buildWorkspaceIndex,
    timeToLive: (exit) =>
      Exit.isSuccess(exit) ? Duration.millis(WORKSPACE_CACHE_TTL_MS) : Duration.zero,
  });

  const normalizeWorkspaceRoot = Effect.fn("WorkspaceEntries.normalizeWorkspaceRoot")(function* (
    cwd: string,
  ): Effect.fn.Return<string, WorkspaceEntriesError> {
    return yield* workspacePaths.normalizeWorkspaceRoot(cwd).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceEntriesError({
            cwd,
            operation: "workspaceEntries.normalizeWorkspaceRoot",
            detail: cause.message,
            cause,
          }),
      ),
    );
  });

  const invalidate: WorkspaceEntriesShape["invalidate"] = Effect.fn("WorkspaceEntries.invalidate")(
    function* (cwd) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(cwd).pipe(
        Effect.catch(() => Effect.succeed(cwd)),
      );
      yield* Cache.invalidate(workspaceIndexCache, `local\u0000${cwd}`);
      if (normalizedCwd !== cwd) {
        yield* Cache.invalidate(workspaceIndexCache, `local\u0000${normalizedCwd}`);
      }
    },
  );

  const search: WorkspaceEntriesShape["search"] = Effect.fn("WorkspaceEntries.search")(
    function* (input) {
      const executionTargetId = resolveExecutionTargetId(input.executionTargetId);
      const normalizedCwd = isLocalExecutionTarget(executionTargetId)
        ? yield* normalizeWorkspaceRoot(input.cwd)
        : input.cwd;
      const indexEffect = isLocalExecutionTarget(executionTargetId)
        ? Cache.get(workspaceIndexCache, `${executionTargetId}\u0000${normalizedCwd}`)
        : buildRemoteWorkspaceIndex({
            cwd: normalizedCwd,
            executionTargetId,
          });
      return yield* indexEffect.pipe(
        Effect.map((index) => {
          const normalizedQueryStr = normalizeQuery(input.query);
          const limit = Math.max(0, Math.floor(input.limit));
          const rankedEntries: RankedWorkspaceEntry[] = [];
          let matchedEntryCount = 0;

          for (const entry of index.entries) {
            const score = scoreEntry(entry, normalizedQueryStr);
            if (score === null) {
              continue;
            }

            matchedEntryCount += 1;
            insertRankedEntry(rankedEntries, { entry, score }, limit);
          }

          return {
            entries: rankedEntries.map((candidate) => candidate.entry),
            truncated: index.truncated || matchedEntryCount > limit,
          };
        }),
      );
    },
  );

  return {
    invalidate,
    search,
  } satisfies WorkspaceEntriesShape;
});

export const WorkspaceEntriesLive = Layer.effect(WorkspaceEntries, makeWorkspaceEntries);
