import { RemoteAgentConnectionError, type RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import {
  REMOTE_AGENT_SEARCH_STREAM_CAPABILITY,
  type RemoteAgentWorkspaceSearchRequest,
} from "./remoteAgentProtocol.search.ts";

/** A connection that answers every search with one hit, or fails the transport `failures` times. */
export function fakeSearchConnection(
  options: { readonly capable?: boolean; readonly failures?: number } = {},
) {
  const requests: RemoteAgentWorkspaceSearchRequest[] = [];
  let failures = options.failures ?? 0;
  let pending: RemoteAgentFrame | undefined;
  const connection = {
    supportsCapability: (name: string) =>
      (options.capable ?? true) && name === REMOTE_AGENT_SEARCH_STREAM_CAPABILITY,
    request: async (frame: RemoteAgentFrame) => {
      if (frame.type !== "workspaceSearchRequest") throw new Error(`unexpected ${frame.type}`);
      if (failures > 0) {
        failures -= 1;
        throw new RemoteAgentConnectionError("Remote agent connection closed.");
      }
      const request = frame.value;
      requests.push(request);
      pending = {
        type: "workspaceSearchCompleted",
        value: {
          requestId: request.requestId,
          operationId: request.operationId,
          stopReason: "complete",
          truncated: false,
          filesScanned: 1,
          rootErrors: [],
          errorCode: "",
          errorMessage: "",
          batches: 1,
        },
      };
      return {
        type: "workspaceSearchBatch",
        value: {
          requestId: request.requestId,
          operationId: request.operationId,
          sequence: 1,
          names: [],
          contents: [{ rootId: "project", path: "src/a.ts", line: 1, column: 14, excerpt: "x" }],
        },
      } as RemoteAgentFrame;
    },
    nextFrame: async () => pending!,
  } as unknown as RemoteAgentConnection;
  return { connection, requests };
}
