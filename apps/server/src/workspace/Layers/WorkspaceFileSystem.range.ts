import { Effect } from "effect";
import { resolveExecutionTargetId } from "@bigbud/contracts/core/baseSchemas.ts";
import { open, stat } from "node:fs/promises";

import {
  WorkspaceFileSystemError,
  type WorkspaceFileRangeInput,
  type WorkspaceFileRangeResult,
  type WorkspaceFileSystemShape,
} from "../Services/WorkspaceFileSystem.ts";
import { type WorkspacePathsShape } from "../Services/WorkspacePaths.ts";
import { isLocalExecutionTarget } from "../../executionTargets.ts";
import { runToolCommand, resolveToolTransportTarget } from "../../tool-transport/toolTransport.ts";
import { resolveWorkspaceTarget } from "../../workspace-target/workspaceTarget.ts";

const DEFAULT_FILE_RANGE_MAX_BYTES = 512 * 1024;
const REMOTE_RANGE_SCRIPT =
  'file="$1"; offset="$2"; count="$3"; size=$(wc -c < "$file") || exit 1; printf "%s\\n" "$size"; if [ "$count" -gt 0 ]; then dd if="$file" bs=1 skip="$offset" count="$count" 2>/dev/null | base64 | tr -d "\\n"; fi';

async function readRemoteFileRange(input: {
  readonly executionTargetId: string;
  readonly cwd: string;
  readonly relativePath: string;
  readonly offset: number;
  readonly maxBytes: number;
}): Promise<Omit<WorkspaceFileRangeResult, "relativePath">> {
  const target = resolveToolTransportTarget(
    resolveWorkspaceTarget({
      executionTargetId: input.executionTargetId,
      cwd: input.cwd,
    }),
  );
  const result = await runToolCommand({
    target,
    command: "sh",
    args: [
      "-c",
      REMOTE_RANGE_SCRIPT,
      "sh",
      input.relativePath,
      String(input.offset),
      String(input.maxBytes),
    ],
    timeoutMs: 30_000,
    maxBufferBytes: Math.ceil(input.maxBytes * 1.4) + 128,
    outputMode: "error",
  });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "Remote workspace file range failed.");
  }

  const newlineIndex = result.stdout.indexOf("\n");
  if (newlineIndex < 0) {
    throw new Error("Remote workspace file range returned an invalid size.");
  }
  const sizeBytes = Number(result.stdout.slice(0, newlineIndex).trim());
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error("Remote workspace file range returned an invalid size.");
  }
  const encoded = result.stdout.slice(newlineIndex + 1).replaceAll(/\s/g, "");
  const bytes =
    encoded.length > 0 ? Uint8Array.from(Buffer.from(encoded, "base64")) : new Uint8Array();
  return {
    bytes,
    sizeBytes,
    truncated: input.offset + bytes.byteLength < sizeBytes,
  };
}

export function makeWorkspaceFileRange(
  workspacePaths: WorkspacePathsShape,
): WorkspaceFileSystemShape["readFileRange"] {
  return Effect.fn("WorkspaceFileSystem.readFileRange")(function* (input: WorkspaceFileRangeInput) {
    const executionTargetId = resolveExecutionTargetId(input.executionTargetId);
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    if (!isLocalExecutionTarget(executionTargetId)) {
      const offset = Math.max(0, Math.floor(input.offset));
      const maxBytes = Math.min(
        DEFAULT_FILE_RANGE_MAX_BYTES,
        Math.max(0, Math.floor(input.maxBytes)),
      );
      const result = yield* Effect.tryPromise({
        try: () =>
          readRemoteFileRange({
            executionTargetId,
            cwd: input.cwd,
            relativePath: target.relativePath,
            offset,
            maxBytes,
          }),
        catch: (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.readFileRangeRemote",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
      return { relativePath: target.relativePath, ...result };
    }

    const result = yield* Effect.tryPromise({
      try: async (): Promise<Omit<WorkspaceFileRangeResult, "relativePath">> => {
        const fileStat = await stat(target.absolutePath);
        if (!fileStat.isFile()) {
          throw new Error("Workspace preview target is not a file.");
        }

        const sizeBytes = fileStat.size;
        const offset = Math.max(0, Math.floor(input.offset));
        const maxBytes = Math.min(
          DEFAULT_FILE_RANGE_MAX_BYTES,
          Math.max(0, Math.floor(input.maxBytes)),
        );
        if (offset >= sizeBytes || maxBytes === 0) {
          return {
            bytes: new Uint8Array(),
            sizeBytes,
            truncated: false,
          };
        }

        const fileHandle = await open(target.absolutePath, "r");
        try {
          const buffer = Buffer.alloc(Math.min(maxBytes, sizeBytes - offset));
          const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, offset);
          return {
            bytes: new Uint8Array(buffer.subarray(0, bytesRead)),
            sizeBytes,
            truncated: offset + bytesRead < sizeBytes,
          };
        } finally {
          await fileHandle.close();
        }
      },
      catch: (cause) =>
        new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.readFileRange",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });

    return { relativePath: target.relativePath, ...result };
  });
}
