import { createHash, randomUUID } from "node:crypto";

import { Effect, Layer } from "effect";

import type {
  ProjectEntry,
  ProjectListDirectoryInput,
  ProjectReadFilePreviewInput,
  ProjectSearchEntriesInput,
  ProjectSearchFileContentsInput,
  ProjectWriteFileInput,
} from "@bigbud/contracts/workspace/project.ts";
import { isLocalExecutionTarget } from "../../executionTargets.ts";
import { WorkspaceEntriesError } from "../../workspace/Services/WorkspaceEntries.ts";
import { WorkspaceFileSystemError } from "../../workspace/Services/WorkspaceFileSystem.ts";
import {
  RemoteAgentWorkspaceClient,
  RemoteAgentWorkspaceError,
} from "../../remote-agent/remoteAgentWorkspaceClient.ts";
import type {
  WorkspaceFileRangeInput,
  WorkspaceFileRangeResult,
} from "../../workspace/Services/WorkspaceFileSystem.ts";
import type { WorkspaceFilesShape } from "../Services/WorkspaceFiles.ts";
import type { WorkspaceSearchShape } from "../Services/WorkspaceSearch.ts";
import type { WorkspaceWatchShape } from "../Services/WorkspaceWatch.ts";
import { RemoteWorkspaceRuntime as RemoteWorkspaceRuntimeService } from "../Services/WorkspaceRuntime.ts";
import { makeRemoteWorkspaceWatch } from "../../remote-agent/remoteAgentWorkspaceWatch.ts";
import { readRemoteFile } from "./WorkspaceRuntime.remote.read.ts";
import { withRemoteReadReconnect } from "./WorkspaceRuntime.remote.reconnect.ts";

export interface RemoteAgentClientResolver {
  readonly resolve: (executionTargetId: string) => Promise<RemoteAgentWorkspaceClient>;
}

export interface RemoteWorkspaceRuntimeShape {
  readonly files: WorkspaceFilesShape;
  readonly search: WorkspaceSearchShape;
  readonly watch: WorkspaceWatchShape;
}

const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;
const MAX_REMOTE_WRITE_BYTES = 512 * 1024;

function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32)}`;
}

function remoteTarget(executionTargetId: string | undefined): string {
  const target = executionTargetId ?? "local";
  if (isLocalExecutionTarget(target)) {
    throw new Error("The remote workspace backend requires an SSH execution target.");
  }
  return target;
}

function workspaceHandle(executionTargetId: string, cwd: string): string {
  return stableId("workspace", { executionTargetId, cwd });
}

function operationId(kind: string): string {
  return `${kind}-${randomUUID()}`;
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function projectEntry(entry: {
  readonly path: string;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
}): ProjectEntry {
  const parentPath = entry.path.includes("/")
    ? entry.path.slice(0, entry.path.lastIndexOf("/"))
    : undefined;
  return {
    path: entry.path,
    kind: entry.isDirectory ? "directory" : entry.isFile ? "file" : "file",
    ...(parentPath ? { parentPath } : {}),
  };
}

function clientFor(
  resolver: RemoteAgentClientResolver,
  executionTargetId: string | undefined,
): Promise<RemoteAgentWorkspaceClient> {
  return resolver.resolve(remoteTarget(executionTargetId));
}

function workspaceError(input: {
  readonly cwd: string;
  readonly relativePath?: string;
  readonly operation: string;
  readonly cause: unknown;
}): WorkspaceFileSystemError {
  return new WorkspaceFileSystemError({
    cwd: input.cwd,
    ...(input.relativePath !== undefined ? { relativePath: input.relativePath } : {}),
    operation: input.operation,
    detail: detail(input.cause),
    cause: input.cause,
  });
}

function entriesError(input: {
  readonly cwd: string;
  readonly operation: string;
  readonly cause: unknown;
}): WorkspaceEntriesError {
  return new WorkspaceEntriesError({
    cwd: input.cwd,
    operation: input.operation,
    detail: detail(input.cause),
    cause: input.cause,
  });
}

export function makeRemoteWorkspaceRuntime(
  resolver: RemoteAgentClientResolver,
): RemoteWorkspaceRuntimeShape {
  const open = async (client: RemoteAgentWorkspaceClient, target: string, cwd: string) => {
    const handle = workspaceHandle(target, cwd);
    await client.openWorkspace(handle, cwd);
    return handle;
  };

  const readFilePreview: WorkspaceFilesShape["readFilePreview"] = Effect.fn(
    "RemoteWorkspaceFiles.readFilePreview",
  )(function* (input: ProjectReadFilePreviewInput) {
    const target = remoteTarget(input.executionTargetId);
    const id = operationId("read");
    const response = yield* Effect.tryPromise({
      try: async () => {
        return withRemoteReadReconnect({
          resolver,
          target,
          operation: async (client) => {
            const handle = await open(client, target, input.cwd);
            return readRemoteFile({
              client,
              workspaceHandle: handle,
              path: input.relativePath,
              operationId: id,
              requestDigest: new TextEncoder().encode(JSON.stringify(input)),
              offset: 0,
              maxBytes: MAX_PREVIEW_BYTES,
            });
          },
        });
      },
      catch: (cause) =>
        workspaceError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "remoteWorkspace.readFilePreview",
          cause,
        }),
    });
    if (response.totalBytes > MAX_PREVIEW_BYTES || response.truncated) {
      return yield* new WorkspaceFileSystemError({
        cwd: input.cwd,
        relativePath: input.relativePath,
        operation: "remoteWorkspace.readFilePreview",
        detail: "File is too large to preview (maximum 5 MiB).",
      });
    }
    if (response.bytes.includes(0)) {
      return yield* new WorkspaceFileSystemError({
        cwd: input.cwd,
        relativePath: input.relativePath,
        operation: "remoteWorkspace.readFilePreview",
        detail: "File is not valid UTF-8 text and cannot be previewed.",
      });
    }
    const contents = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(response.bytes),
      catch: (cause) =>
        new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "remoteWorkspace.readFilePreview",
          detail: "File is not valid UTF-8 text and cannot be previewed.",
          cause,
        }),
    });
    return {
      relativePath: input.relativePath,
      contents,
      sizeBytes: response.totalBytes,
      truncated: false,
    };
  });

  const writeFile: WorkspaceFilesShape["writeFile"] = Effect.fn("RemoteWorkspaceFiles.writeFile")(
    function* (input: ProjectWriteFileInput) {
      const target = remoteTarget(input.executionTargetId);
      const bytes = new TextEncoder().encode(input.contents);
      if (input.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.expectedSha256)) {
        return yield* new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "remoteWorkspace.writeFile",
          detail: "expectedSha256 must be a lowercase SHA-256 digest.",
        });
      }
      if (bytes.byteLength > MAX_REMOTE_WRITE_BYTES) {
        return yield* new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "remoteWorkspace.writeFile",
          detail: "Remote file writes are limited to 512 KiB.",
        });
      }
      yield* Effect.tryPromise({
        try: async () => {
          const client = await clientFor(resolver, target);
          const handle = await open(client, target, input.cwd);
          await client.writeFile({
            workspaceHandle: handle,
            path: input.relativePath,
            bytes,
            operationId: operationId("write"),
            requestDigest: new TextEncoder().encode(JSON.stringify(input)),
            ...(input.expectedSha256 !== undefined ? { expectedSha256: input.expectedSha256 } : {}),
          });
        },
        catch: (cause) =>
          workspaceError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "remoteWorkspace.writeFile",
            cause,
          }),
      });
      return { relativePath: input.relativePath };
    },
  );

  const readFileRange: WorkspaceFilesShape["readFileRange"] = Effect.fn(
    "RemoteWorkspaceFiles.readFileRange",
  )(function* (input: WorkspaceFileRangeInput) {
    const target = remoteTarget(input.executionTargetId);
    const id = operationId("read-range");
    const response = yield* Effect.tryPromise({
      try: async () => {
        return withRemoteReadReconnect({
          resolver,
          target,
          operation: async (client) => {
            const handle = await open(client, target, input.cwd);
            return readRemoteFile({
              client,
              workspaceHandle: handle,
              path: input.relativePath,
              operationId: id,
              requestDigest: new TextEncoder().encode(JSON.stringify(input)),
              offset: Math.max(0, Math.floor(input.offset)),
              maxBytes: input.maxBytes,
            });
          },
        });
      },
      catch: (cause) =>
        workspaceError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "remoteWorkspace.readFileRange",
          cause,
        }),
    });
    return {
      relativePath: input.relativePath,
      bytes: response.bytes,
      sizeBytes: response.totalBytes,
      truncated: response.truncated,
    } satisfies WorkspaceFileRangeResult;
  });

  const listDirectory: WorkspaceFilesShape["listDirectory"] = Effect.fn(
    "RemoteWorkspaceFiles.listDirectory",
  )(function* (input: ProjectListDirectoryInput) {
    const target = remoteTarget(input.executionTargetId);
    const id = operationId("list");
    const relativePath = input.relativePath ?? ".";
    const entries = yield* Effect.tryPromise({
      try: async () => {
        return withRemoteReadReconnect({
          resolver,
          target,
          operation: async (client) => {
            const handle = await open(client, target, input.cwd);
            return client.listDirectory({
              workspaceHandle: handle,
              path: relativePath,
              operationId: id,
              requestDigest: new TextEncoder().encode(JSON.stringify(input)),
            });
          },
        });
      },
      catch: (cause) =>
        entriesError({
          cwd: input.cwd,
          operation: "remoteWorkspace.listDirectory",
          cause,
        }),
    });
    return { entries: entries.map(projectEntry) };
  });

  const searchEntries: WorkspaceSearchShape["searchEntries"] = Effect.fn(
    "RemoteWorkspaceSearch.searchEntries",
  )(function* (input: ProjectSearchEntriesInput) {
    const target = remoteTarget(input.executionTargetId);
    const id = operationId("search-entries");
    const entries = yield* Effect.tryPromise({
      try: async () => {
        return withRemoteReadReconnect({
          resolver,
          target,
          operation: async (client) => {
            const handle = await open(client, target, input.cwd);
            return client.searchFilenames({
              workspaceHandle: handle,
              path: ".",
              query: input.query,
              maxResults: input.limit,
              operationId: id,
              requestDigest: new TextEncoder().encode(JSON.stringify(input)),
            });
          },
        });
      },
      catch: (cause) =>
        entriesError({
          cwd: input.cwd,
          operation: "remoteWorkspace.searchEntries",
          cause,
        }),
    });
    return { entries: entries.map(projectEntry), truncated: entries.length >= input.limit };
  });

  const searchFileContents: WorkspaceSearchShape["searchFileContents"] = Effect.fn(
    "RemoteWorkspaceSearch.searchFileContents",
  )(function* (input: ProjectSearchFileContentsInput) {
    const target = remoteTarget(input.executionTargetId);
    const id = operationId("search-content");
    const response = yield* Effect.tryPromise({
      try: async () => {
        return withRemoteReadReconnect({
          resolver,
          target,
          operation: async (client) => {
            const handle = await open(client, target, input.cwd);
            return client.searchContent({
              workspaceHandle: handle,
              path: ".",
              query: input.query,
              maxResults: input.limit,
              operationId: id,
              requestDigest: new TextEncoder().encode(JSON.stringify(input)),
            });
          },
        });
      },
      catch: (cause) =>
        workspaceError({
          cwd: input.cwd,
          operation: "remoteWorkspace.searchFileContents",
          cause,
        }),
    });
    return {
      matches: response.matches.map((match) => ({
        path: match.path,
        line: match.line,
        column: match.column,
        lineText: match.excerpt,
      })),
      truncated: response.truncated,
    };
  });

  return {
    files: { writeFile, readFilePreview, readFileRange, listDirectory },
    search: { searchEntries, searchFileContents },
    watch: makeRemoteWorkspaceWatch(resolver),
  };
}

export function makeRemoteWorkspaceRuntimeLayer(resolver: RemoteAgentClientResolver) {
  return Layer.succeed(RemoteWorkspaceRuntimeService, makeRemoteWorkspaceRuntime(resolver));
}

export { RemoteAgentWorkspaceError };
