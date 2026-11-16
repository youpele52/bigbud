import { decodePtyInventoryFrame } from "./remoteAgentProtocol.codec.pty.inventory.ts";
import { decodePtyInputReconcileFrame } from "./remoteAgentProtocol.codec.pty.input.ts";
import { decodeMessage, requireWireType } from "./remoteAgentProtocol.codec.wire";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import { decodePtyRequest } from "./remoteAgentProtocol.codec.pty.decode.requests.ts";
import { decodePtyResponse } from "./remoteAgentProtocol.codec.pty.decode.responses.ts";

export function decodePtyFrame(field: number, bytes: Uint8Array): RemoteAgentFrame | undefined {
  if (field === 62) {
    const value = { requestId: "", ptyId: "" };
    decodeMessage(bytes, (field, wireType, reader) => {
      if (field === 1 || field === 2) {
        requireWireType(wireType, 2);
        if (field === 1) value.requestId = reader.string();
        else value.ptyId = reader.string();
      } else reader.skip(wireType);
    });
    return { type: "ptyDetachRequest", value };
  }
  return (
    decodePtyRequest(field, bytes) ??
    decodePtyResponse(field, bytes) ??
    decodePtyInventoryFrame(field, bytes) ??
    decodePtyInputReconcileFrame(field, bytes)
  );
}
