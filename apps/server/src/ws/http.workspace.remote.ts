import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import type { WorkspaceRuntimeBackendShape } from "../workspace-runtime/Services/WorkspaceRuntime.ts";
import { parseByteRangeHeader } from "./http.fileResponse.ts";

const MAX_REMOTE_RESPONSE_BYTES = 32 * 1024 * 1024;

function remoteHeaders(input: {
  readonly contentType: string;
  readonly cacheControl: string;
  readonly start?: number;
  readonly end?: number;
  readonly totalBytes: number;
  readonly contentLength: number;
}): Record<string, string> {
  return {
    "Cache-Control": input.cacheControl,
    "Content-Type": input.contentType,
    "Accept-Ranges": "bytes",
    "Content-Length": String(input.contentLength),
    ...(input.start !== undefined && input.end !== undefined
      ? { "Content-Range": `bytes ${input.start}-${input.end}/${input.totalBytes}` }
      : {}),
  };
}

export const serveRemoteWorkspaceFile = Effect.fn("http.serveRemoteWorkspaceFile")(
  function* (input: {
    readonly request: HttpServerRequest.HttpServerRequest;
    readonly files: WorkspaceRuntimeBackendShape["files"];
    readonly executionTargetId: string;
    readonly cwd: string;
    readonly relativePath: string;
    readonly contentType: string;
    readonly cacheControl: string;
  }) {
    const rangeHeader = input.request.headers["range"];
    const initial = yield* input.files.readFileRange({
      executionTargetId: input.executionTargetId,
      cwd: input.cwd,
      relativePath: input.relativePath,
      offset: 0,
      maxBytes: rangeHeader ? 0 : MAX_REMOTE_RESPONSE_BYTES,
    });
    const parsedRange = parseByteRangeHeader(rangeHeader, initial.sizeBytes);

    if (parsedRange === "unsatisfiable") {
      return HttpServerResponse.text("Range Not Satisfiable", {
        status: 416,
        headers: {
          "Content-Range": `bytes */${initial.sizeBytes}`,
        },
      });
    }

    if (parsedRange === null) {
      const end = initial.bytes.byteLength - 1;
      const isPartial = initial.truncated || initial.bytes.byteLength < initial.sizeBytes;
      return HttpServerResponse.uint8Array(initial.bytes, {
        status: isPartial ? 206 : 200,
        contentType: input.contentType,
        headers: remoteHeaders({
          contentType: input.contentType,
          cacheControl: input.cacheControl,
          ...(isPartial && end >= 0 ? { start: 0, end } : {}),
          totalBytes: initial.sizeBytes,
          contentLength: initial.bytes.byteLength,
        }),
      });
    }

    const requestedBytes = parsedRange.end - parsedRange.start + 1;
    const result = yield* input.files.readFileRange({
      executionTargetId: input.executionTargetId,
      cwd: input.cwd,
      relativePath: input.relativePath,
      offset: parsedRange.start,
      maxBytes: Math.min(requestedBytes, MAX_REMOTE_RESPONSE_BYTES),
    });
    const end =
      result.bytes.byteLength > 0
        ? parsedRange.start + result.bytes.byteLength - 1
        : parsedRange.start;
    return HttpServerResponse.uint8Array(result.bytes, {
      status: 206,
      contentType: input.contentType,
      headers: remoteHeaders({
        contentType: input.contentType,
        cacheControl: input.cacheControl,
        start: parsedRange.start,
        end,
        totalBytes: result.sizeBytes,
        contentLength: result.bytes.byteLength,
      }),
    });
  },
);
