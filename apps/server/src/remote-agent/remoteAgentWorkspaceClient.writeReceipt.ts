import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import {
  REMOTE_AGENT_WRITE_CAPABILITY,
  REMOTE_AGENT_WRITE_RECEIPT_MINOR,
  type RemoteAgentWriteReceiptResponse,
} from "./remoteAgentProtocol.writeReceipt.ts";

/** Outcome of a write receipt query; `applied: false` never proves the write did not land. */
export interface RemoteAgentWriteReceipt {
  readonly applied: boolean;
  readonly resultSha256?: string;
}

/**
 * Negotiated 1.x minor of a capability, or undefined when it is not advertised. The connection
 * only exposes capability names, so this reads its negotiated hello list (type-checked access).
 */
export function remoteAgentCapabilityMinor(
  connection: RemoteAgentConnection,
  name: string,
): number | undefined {
  if (!connection.supportsCapability(name)) return undefined;
  const capability = connection["negotiatedCapabilities"]?.find(
    (candidate) => candidate.name === name && candidate.major === 1,
  );
  return capability && Number.isInteger(capability.minor) ? capability.minor : undefined;
}

/** Agents advertising `workspace.write` 1.2 answer write receipt queries. */
export function supportsRemoteAgentWriteReceipt(connection: RemoteAgentConnection): boolean {
  return (
    (remoteAgentCapabilityMinor(connection, REMOTE_AGENT_WRITE_CAPABILITY) ?? 0) >=
    REMOTE_AGENT_WRITE_RECEIPT_MINOR
  );
}

/** Sends one read-only receipt query; it never performs or retries the write. */
export async function requestRemoteAgentWriteReceipt(
  connection: RemoteAgentConnection,
  input: {
    readonly requestId: string;
    readonly operationId: string;
    readonly requestDigest: Uint8Array;
  },
): Promise<RemoteAgentWriteReceiptResponse> {
  const response = (await connection.request(
    { type: "writeReceiptRequest", value: input },
    (frame) => frame.type === "writeReceiptResponse" && frame.value.requestId === input.requestId,
  )) as { readonly type: "writeReceiptResponse"; readonly value: RemoteAgentWriteReceiptResponse };
  return response.value;
}
