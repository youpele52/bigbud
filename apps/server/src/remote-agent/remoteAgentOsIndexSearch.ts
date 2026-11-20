import { randomUUID } from "node:crypto";

import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import type {
  RemoteAgentOsIndexSearchCompleted,
  RemoteAgentOsIndexSearchHit,
  RemoteAgentOsIndexSearchRequest,
} from "./remoteAgentProtocol.search.ts";
import { cancelSearchOnAbort } from "./remoteAgentWorkspaceSearch.ts";

/**
 * Runs one `OsIndexSearchRequest` (capability `os-index.search`, desktop-embedded local agent
 * only). The agent answers with at most one batch and exactly one completion; aborting sends
 * `CancelRequest`, and the reply is still drained so no frame is left in the inbox.
 */
export async function runRemoteAgentOsIndexSearch(
  connection: Pick<RemoteAgentConnection, "request" | "nextFrame">,
  request: Omit<RemoteAgentOsIndexSearchRequest, "requestId">,
  options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<{
  readonly hits: ReadonlyArray<RemoteAgentOsIndexSearchHit>;
  readonly completed: RemoteAgentOsIndexSearchCompleted;
}> {
  const requestId = randomUUID();
  const isOurs = (frame: RemoteAgentFrame) =>
    (frame.type === "osIndexSearchBatch" || frame.type === "osIndexSearchCompleted") &&
    frame.value.requestId === requestId;
  const cancellation = cancelSearchOnAbort(connection, {
    requestId,
    operationId: request.operationId,
    signal: options.signal,
  });
  try {
    const hits: RemoteAgentOsIndexSearchHit[] = [];
    let frame = await connection.request(
      { type: "osIndexSearchRequest", value: { ...request, requestId } },
      isOurs,
    );
    while (frame.type === "osIndexSearchBatch") {
      if (!options.signal?.aborted) hits.push(...frame.value.hits);
      frame = await connection.nextFrame(isOurs);
    }
    await cancellation.settled();
    return { hits, completed: frame.value as RemoteAgentOsIndexSearchCompleted };
  } finally {
    cancellation.dispose();
  }
}
