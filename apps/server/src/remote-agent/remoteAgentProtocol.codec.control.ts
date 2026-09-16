import type {
  RemoteAgentSupervisorShutdownRequest,
  RemoteAgentSupervisorShutdownResponse,
} from "./remoteAgentProtocol.control.ts";
import { decodeMessage, requireWireType, WireWriter } from "./remoteAgentProtocol.codec.wire.ts";

export function encodeSupervisorShutdownRequest(
  value: RemoteAgentSupervisorShutdownRequest,
): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.expectedAgentEpoch);
  writer.fieldString(3, value.expectedBuildDigest);
  return writer.finish();
}

export function encodeSupervisorShutdownResponse(
  value: RemoteAgentSupervisorShutdownResponse,
): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldBool(2, value.accepted);
  writer.fieldBool(3, value.terminal);
  writer.fieldString(4, value.detail);
  return writer.finish();
}

export function decodeSupervisorShutdownRequest(
  bytes: Uint8Array,
): RemoteAgentSupervisorShutdownRequest {
  const value = { requestId: "", expectedAgentEpoch: "", expectedBuildDigest: "" };
  decodeMessage(bytes, (field, wireType, reader) => {
    if (field === 1 || field === 2 || field === 3) {
      requireWireType(wireType, 2);
      if (field === 1) value.requestId = reader.string();
      else if (field === 2) value.expectedAgentEpoch = reader.string();
      else value.expectedBuildDigest = reader.string();
    } else reader.skip(wireType);
  });
  return value;
}

export function decodeSupervisorShutdownResponse(
  bytes: Uint8Array,
): RemoteAgentSupervisorShutdownResponse {
  const value = { requestId: "", accepted: false, terminal: false, detail: "" };
  decodeMessage(bytes, (field, wireType, reader) => {
    switch (field) {
      case 1:
        requireWireType(wireType, 2);
        value.requestId = reader.string();
        break;
      case 2:
        requireWireType(wireType, 0);
        value.accepted = reader.uint() !== 0;
        break;
      case 3:
        requireWireType(wireType, 0);
        value.terminal = reader.uint() !== 0;
        break;
      case 4:
        requireWireType(wireType, 2);
        value.detail = reader.string();
        break;
      default:
        reader.skip(wireType);
    }
  });
  return value;
}

export function decodeRemoteAgentControlFrame(field: number, bytes: Uint8Array) {
  if (field === 33)
    return {
      type: "supervisorShutdownRequest" as const,
      value: decodeSupervisorShutdownRequest(bytes),
    };
  if (field === 34)
    return {
      type: "supervisorShutdownResponse" as const,
      value: decodeSupervisorShutdownResponse(bytes),
    };
  return undefined;
}
