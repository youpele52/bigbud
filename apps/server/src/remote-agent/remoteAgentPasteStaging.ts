import { randomBytes, randomUUID } from "node:crypto";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import type { RemoteAgentPasteStagingFrame } from "./remoteAgentProtocol.pasteStaging.ts";

const REQUEST_TIMEOUT_MS = 30_000;

export class RemoteAgentPasteStagingError extends Error {
  readonly _tag = "RemoteAgentPasteStagingError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RemoteAgentPasteStagingError";
  }
}

type Response<T extends RemoteAgentPasteStagingFrame["type"]> = Extract<
  RemoteAgentPasteStagingFrame,
  { type: T }
>["value"];

async function exchange<T extends RemoteAgentPasteStagingFrame["type"]>(
  connection: RemoteAgentConnection,
  frame: RemoteAgentFrame & { readonly value: { readonly requestId: string } },
  responseType: T,
): Promise<Response<T>> {
  const requestId = frame.value.requestId;
  const response = await connection.request(
    frame,
    (candidate) =>
      candidate.type === responseType &&
      (candidate.value as { requestId?: string }).requestId === requestId,
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  );
  const value = response.value as Response<T>;
  const failure = value as { readonly errorCode?: string; readonly errorMessage?: string };
  if (failure.errorCode)
    throw new RemoteAgentPasteStagingError(failure.errorCode, failure.errorMessage ?? "");
  return value;
}

export interface RemoteAgentPasteUpload {
  readonly write: (chunk: Uint8Array) => Promise<void>;
  readonly commit: (
    sha256Hex: string,
  ) => Promise<{ readonly path: string; readonly clipboard: string }>;
  readonly abort: () => Promise<void>;
}

/** Chunked upload into the agent's private paste folder (`terminal.paste-staging`). */
export async function beginRemoteAgentPasteUpload(
  connection: RemoteAgentConnection,
  input: {
    readonly scope: string;
    readonly extension: string;
    readonly imageMimeType: string | null;
    readonly totalBytes: number;
  },
): Promise<RemoteAgentPasteUpload> {
  const uploadId = randomBytes(16).toString("hex");
  const begun = await exchange(
    connection,
    {
      type: "pasteStageBeginRequest",
      value: {
        requestId: randomUUID(),
        scope: input.scope,
        uploadId,
        totalBytes: input.totalBytes,
        extension: input.extension,
        imageMimeType: input.imageMimeType ?? "",
      },
    },
    "pasteStageBeginResponse",
  );
  if (!begun.accepted || begun.maxChunkBytes <= 0)
    throw new RemoteAgentPasteStagingError("REJECTED", "The remote agent refused the upload.");
  let offset = 0;
  return {
    write: async (chunk) => {
      for (let start = 0; start < chunk.byteLength; start += begun.maxChunkBytes) {
        const data = chunk.subarray(start, start + begun.maxChunkBytes);
        const written = await exchange(
          connection,
          {
            type: "pasteStageChunkRequest",
            value: { requestId: randomUUID(), uploadId, offset, data },
          },
          "pasteStageChunkResponse",
        );
        if (written.receivedBytes !== offset + data.byteLength)
          throw new RemoteAgentPasteStagingError("OUT_OF_ORDER", "The remote upload lost a chunk.");
        offset = written.receivedBytes;
      }
    },
    commit: async (sha256Hex) => {
      const committed = await exchange(
        connection,
        {
          type: "pasteStageCommitRequest",
          value: { requestId: randomUUID(), uploadId, sha256: Buffer.from(sha256Hex, "hex") },
        },
        "pasteStageCommitResponse",
      );
      return { path: committed.path, clipboard: committed.clipboard };
    },
    abort: async () => {
      await exchange(
        connection,
        {
          type: "pasteStageDiscardRequest",
          value: { requestId: randomUUID(), scope: "", uploadId },
        },
        "pasteStageDiscardResponse",
      );
    },
  };
}

/** Deletes every file staged for one terminal generation. Idempotent. */
export async function discardRemoteAgentPasteScope(
  connection: RemoteAgentConnection,
  scope: string,
): Promise<number> {
  const response = await exchange(
    connection,
    { type: "pasteStageDiscardRequest", value: { requestId: randomUUID(), scope, uploadId: "" } },
    "pasteStageDiscardResponse",
  );
  return response.removed;
}
