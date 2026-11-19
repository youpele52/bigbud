import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type {
  ProjectWriteFileInput,
  ProjectWriteFileDisposition,
} from "@bigbud/contracts/workspace/project.ts";
import {
  REMOTE_AGENT_ALREADY_EXISTS,
  REMOTE_AGENT_CREATE_ONLY_WRITE_CAPABILITY,
  RemoteAgentWorkspaceClient,
  RemoteAgentWorkspaceError,
} from "../../remote-agent/remoteAgentWorkspaceClient.ts";
import { remoteAgentRequestDigest } from "../../remote-agent/remoteAgentRequestDigest.ts";
import {
  WORKSPACE_FILE_ALREADY_EXISTS,
  WORKSPACE_WRITE_CREATE_ONLY_OPERATION,
  WorkspaceFileSystemError,
} from "../../workspace/Services/WorkspaceFileSystem.ts";
import type { WorkspaceFilesShape } from "../Services/WorkspaceFiles.ts";

const MAX_REMOTE_WRITE_BYTES = 512 * 1024;

/** Preserve write settlement evidence without treating interruption as native completion. */
export function makeRemoteWorkspaceWriteFile(options: {
  readonly resolve: (target: string) => Promise<RemoteAgentWorkspaceClient>;
  readonly remoteTarget: (target: string | undefined) => string;
  readonly open: (
    client: RemoteAgentWorkspaceClient,
    target: string,
    cwd: string,
  ) => Promise<string>;
}): WorkspaceFilesShape["writeFile"] {
  return Effect.fn("RemoteWorkspaceFiles.writeFile")(function* (input: ProjectWriteFileInput) {
    const target = options.remoteTarget(input.executionTargetId);
    const bytes = new TextEncoder().encode(input.contents);
    const error = (cause: unknown, writeDisposition?: ProjectWriteFileDisposition) =>
      cause instanceof RemoteAgentWorkspaceError && cause.code === REMOTE_AGENT_ALREADY_EXISTS
        ? new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: WORKSPACE_WRITE_CREATE_ONLY_OPERATION,
            detail: WORKSPACE_FILE_ALREADY_EXISTS,
            writeDisposition: "terminal",
            cause,
          })
        : new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "remoteWorkspace.writeFile",
            detail: cause instanceof Error ? cause.message : String(cause),
            // tryPromise can call this on interruption while the native request is still pending.
            writeDisposition:
              writeDisposition ??
              (cause instanceof RemoteAgentWorkspaceError
                ? (cause.writeDisposition ?? "unknown")
                : "unknown"),
            cause,
          });
    if (input.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.expectedSha256)) {
      return yield* error("expectedSha256 must be a lowercase SHA-256 digest.", "not-dispatched");
    }
    if (input.createOnly === true && input.expectedSha256 !== undefined) {
      return yield* error("createOnly cannot be combined with expectedSha256.", "not-dispatched");
    }
    if (bytes.byteLength > MAX_REMOTE_WRITE_BYTES) {
      return yield* error("Remote file writes are limited to 512 KiB.", "not-dispatched");
    }
    yield* Effect.tryPromise({
      try: async () => {
        let writeStarted = false;
        try {
          const client = await options.resolve(target);
          // Older agents drop the unknown createOnly field and would overwrite; never send it.
          if (
            input.createOnly === true &&
            !client.connection.supportsCapability(REMOTE_AGENT_CREATE_ONLY_WRITE_CAPABILITY)
          ) {
            throw new Error("Create-only writes need a newer remote agent; update it and retry.");
          }
          const handle = await options.open(client, target, input.cwd);
          writeStarted = true;
          await client.writeFile({
            workspaceHandle: handle,
            path: input.relativePath,
            bytes,
            operationId: input.operationId ?? `write-${randomUUID()}`,
            requestDigest: remoteAgentRequestDigest(input),
            ...(input.expectedSha256 !== undefined ? { expectedSha256: input.expectedSha256 } : {}),
            ...(input.createOnly === true ? { createOnly: true } : {}),
          });
        } catch (cause) {
          if (writeStarted) throw cause;
          throw new RemoteAgentWorkspaceError(
            "WRITE_NOT_DISPATCHED",
            cause instanceof Error ? cause.message : String(cause),
            "not-dispatched",
          );
        }
      },
      catch: error,
    });
    return { relativePath: input.relativePath };
  });
}
