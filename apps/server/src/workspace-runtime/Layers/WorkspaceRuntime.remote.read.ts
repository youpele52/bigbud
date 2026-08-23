import type { RemoteAgentReadFileResponse } from "../../remote-agent/remoteAgentProtocol.ts";
import { RemoteAgentWorkspaceClient } from "../../remote-agent/remoteAgentWorkspaceClient.ts";

const MAX_REMOTE_READ_CHUNK_BYTES = 512 * 1024;

function combineBytes(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function readRemoteFile(input: {
  readonly client: RemoteAgentWorkspaceClient;
  readonly workspaceHandle: string;
  readonly path: string;
  readonly operationId: string;
  readonly requestDigest: Uint8Array;
  readonly offset: number;
  readonly maxBytes: number;
}): Promise<RemoteAgentReadFileResponse> {
  const chunks: Uint8Array[] = [];
  let nextOffset = input.offset;
  let totalBytes = 0;
  let truncated = false;
  let last: RemoteAgentReadFileResponse | undefined;
  const boundedMaxBytes = Math.max(0, Math.floor(input.maxBytes));

  while (chunks.reduce((total, chunk) => total + chunk.byteLength, 0) < boundedMaxBytes) {
    const receivedBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const response = await input.client.readFile({
      workspaceHandle: input.workspaceHandle,
      path: input.path,
      operationId: `${input.operationId}-${nextOffset}`,
      requestDigest: input.requestDigest,
      offset: nextOffset,
      maxBytes: Math.min(MAX_REMOTE_READ_CHUNK_BYTES, boundedMaxBytes - receivedBytes),
    });
    last = response;
    totalBytes = response.totalBytes;
    truncated = response.truncated;
    if (response.bytes.byteLength === 0) break;
    chunks.push(response.bytes);
    nextOffset += response.bytes.byteLength;
    if (!response.truncated) break;
  }

  if (!last) {
    last = await input.client.readFile({
      workspaceHandle: input.workspaceHandle,
      path: input.path,
      operationId: `${input.operationId}-${input.offset}`,
      requestDigest: input.requestDigest,
      offset: input.offset,
      maxBytes: 0,
    });
    totalBytes = last.totalBytes;
    truncated = last.truncated;
  }

  return {
    ...last,
    bytes: combineBytes(chunks),
    totalBytes,
    truncated: truncated || nextOffset < totalBytes,
  };
}
