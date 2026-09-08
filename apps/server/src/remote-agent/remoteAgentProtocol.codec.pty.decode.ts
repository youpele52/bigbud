import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import { decodePtyRequest } from "./remoteAgentProtocol.codec.pty.decode.requests.ts";
import { decodePtyResponse } from "./remoteAgentProtocol.codec.pty.decode.responses.ts";

export function decodePtyFrame(field: number, bytes: Uint8Array): RemoteAgentFrame | undefined {
  return decodePtyRequest(field, bytes) ?? decodePtyResponse(field, bytes);
}
