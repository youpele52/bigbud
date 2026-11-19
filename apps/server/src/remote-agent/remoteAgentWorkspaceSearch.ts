import { randomUUID } from "node:crypto";

import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import type {
  RemoteAgentWorkspaceSearchBatch,
  RemoteAgentWorkspaceSearchCompleted,
  RemoteAgentWorkspaceSearchRequest,
} from "./remoteAgentProtocol.search.ts";

export class RemoteAgentSearchSequenceError extends Error {
  constructor(expected: number, actual: number) {
    super(`Workspace search batch ${actual} arrived where ${expected} was expected.`);
    this.name = "RemoteAgentSearchSequenceError";
  }
}

/**
 * Runs one streaming `WorkspaceSearchRequest` (capability `workspace.search-stream`). Batches
 * reach `onBatch` in sequence order. Aborting sends `CancelRequest` and stops delivering
 * batches, but the stream is still drained to its single completion frame so no frame is left
 * unclaimed in the connection inbox.
 */
export async function streamRemoteAgentWorkspaceSearch(
  connection: Pick<RemoteAgentConnection, "request" | "nextFrame">,
  request: Omit<RemoteAgentWorkspaceSearchRequest, "requestId">,
  options: {
    readonly onBatch: (batch: RemoteAgentWorkspaceSearchBatch) => void;
    readonly signal?: AbortSignal;
    readonly requestId?: string;
  },
): Promise<RemoteAgentWorkspaceSearchCompleted> {
  const requestId = options.requestId ?? randomUUID();
  const cancelRequestId = `cancel-${requestId}`;
  const isOurs = (frame: RemoteAgentFrame) =>
    (frame.type === "workspaceSearchBatch" || frame.type === "workspaceSearchCompleted") &&
    frame.value.requestId === requestId;
  let cancelling: Promise<unknown> | undefined;
  const cancel = () => {
    cancelling ??= connection
      .request(
        {
          type: "cancelRequest",
          value: { requestId: cancelRequestId, operationId: request.operationId },
        },
        (frame) => frame.type === "cancelResponse" && frame.value.requestId === cancelRequestId,
      )
      // The completion frame is authoritative; a lost cancel response changes nothing.
      .catch(() => undefined);
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    let frame = await connection.request(
      { type: "workspaceSearchRequest", value: { ...request, requestId } },
      isOurs,
    );
    let expected = 1;
    while (frame.type === "workspaceSearchBatch") {
      if (frame.value.sequence !== expected) {
        throw new RemoteAgentSearchSequenceError(expected, frame.value.sequence);
      }
      expected += 1;
      if (!options.signal?.aborted) options.onBatch(frame.value);
      frame = await connection.nextFrame(isOurs);
    }
    await cancelling;
    return frame.value as RemoteAgentWorkspaceSearchCompleted;
  } finally {
    options.signal?.removeEventListener("abort", cancel);
  }
}
