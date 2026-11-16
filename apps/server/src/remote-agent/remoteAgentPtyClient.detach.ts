import { randomUUID } from "node:crypto";
import type { RemoteAgentConnection } from "./remoteAgentConnection";
import { RemoteAgentPtyError } from "./remoteAgentPtyClient.types";

/** Unsubscribe this connection only. A lost acknowledgement retains local recovery ownership. */
export async function detachRemotePty(
  connection: RemoteAgentConnection,
  ptyId: string,
): Promise<void> {
  if (!connection.supportsCapability("terminal.pty-detach"))
    throw new RemoteAgentPtyError(
      "PTY_DETACH_UNSUPPORTED",
      "This remote agent does not support Detach. Update it before detaching.",
    );
  const requestId = randomUUID();
  const response = await connection.request(
    { type: "ptyDetachRequest", value: { requestId, ptyId } },
    (frame) => frame.type === "ptyDetachResponse" && frame.value.requestId === requestId,
    AbortSignal.timeout(10_000),
  );
  if (
    response.type !== "ptyDetachResponse" ||
    response.value.ptyId !== ptyId ||
    !response.value.accepted
  )
    throw new RemoteAgentPtyError(
      "PTY_DETACH_UNKNOWN",
      "Remote terminal detach was not acknowledged. Recovery ownership was retained.",
    );
}
