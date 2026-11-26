import { randomUUID } from "node:crypto";
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
    AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  );
  const value = response.value as { accepted?: boolean; errorCode?: string; errorMessage?: string };
  if (value.accepted === false)
    throw new RemoteAgentPtyError(
      value.errorCode ?? "PTY_REQUEST_REJECTED",
      value.errorMessage || "Remote PTY request was rejected.",
    );
}

export async function signalRemotePty(
  connection: RemoteAgentConnection,
  ptyId: string,
  signal: string,
  cancellation: AbortSignal,
): Promise<void> {
  const requestId = randomUUID();
  await sendRemotePtyRequest(
    connection,
    { type: "ptySignalRequest", value: { requestId, ptyId, signal } },
    (frame) => frame.type === "ptySignalResponse" && frame.value.requestId === requestId,
    cancellation,
  );
}

/** An acknowledged close is not exit evidence; only `ptyExited` proves termination. */
export async function closeRemotePty(
  connection: RemoteAgentConnection,
  ptyId: string,
  terminate: boolean,
  cancellation: AbortSignal,
): Promise<void> {
  const requestId = randomUUID();
  await sendRemotePtyRequest(
    connection,
    { type: "ptyCloseRequest", value: { requestId, ptyId, terminate } },
    (frame) => frame.type === "ptyCloseResponse" && frame.value.ptyId === ptyId,
    cancellation,
  );
}
