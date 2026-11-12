import type { RemoteAgentConnection } from "./remoteAgentConnection";
import type { RemoteAgentFrame } from "./remoteAgentProtocol";
import { RemoteAgentPtyError } from "./remoteAgentPtyClient.types";

export async function sendRemotePtyRequest(
  connection: RemoteAgentConnection,
  frame: RemoteAgentFrame,
  matches: (frame: RemoteAgentFrame) => boolean,
  signal: AbortSignal,
): Promise<void> {
  const response = await connection.request(
    frame,
    matches,
    frame.type === "ptyCloseRequest" || frame.type === "ptySignalRequest" ? signal : undefined,
  );
  const value = response.value as { accepted?: boolean; errorCode?: string; errorMessage?: string };
  if (value.accepted === false)
    throw new RemoteAgentPtyError(
      value.errorCode ?? "PTY_REQUEST_REJECTED",
      value.errorMessage || "Remote PTY request was rejected.",
    );
}
