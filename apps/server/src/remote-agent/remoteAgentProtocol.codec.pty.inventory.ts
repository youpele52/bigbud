import { RemoteAgentProtocolDecodeError, type RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import type {
  RemoteAgentPtyInventoryEntry,
  RemoteAgentPtyListRequest,
  RemoteAgentPtyListResponse,
} from "./remoteAgentProtocol.pty.ts";
import { decodeMessage, requireWireType, WireWriter } from "./remoteAgentProtocol.codec.wire.ts";

function encodeEntry(value: RemoteAgentPtyInventoryEntry): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.ptyId);
  writer.fieldBytes(2, value.requestDigest);
  writer.fieldString(3, value.state);
  writer.fieldUint(4, value.pid);
  writer.fieldUint(5, value.nextSequence);
  writer.fieldUint(6, value.firstRetainedSequence);
  writer.fieldBool(7, value.verifiedExit);
  writer.fieldString(8, value.launchStatus);
  return writer.finish();
}

export function encodePtyInventoryFrame(
  frame: RemoteAgentFrame,
): { readonly field: number; readonly value: Uint8Array } | undefined {
  const writer = new WireWriter();
  if (frame.type === "ptyListRequest") {
    const value = frame.value;
    writer.fieldString(1, value.requestId);
    writer.fieldString(2, value.expectedEpoch);
    writer.fieldString(3, value.afterPtyId);
    writer.fieldUint(4, value.limit);
    writer.fieldString(5, value.snapshotId);
    return { field: 60, value: writer.finish() };
  }
  if (frame.type === "ptyListResponse") {
    const value = frame.value;
    writer.fieldString(1, value.requestId);
    writer.fieldString(2, value.agentEpoch);
    for (const entry of value.entries) writer.fieldMessage(3, encodeEntry(entry));
    writer.fieldString(4, value.nextAfterPtyId);
    writer.fieldString(5, value.snapshotId);
    writer.fieldBool(6, value.accepted);
    writer.fieldString(7, value.errorCode);
    return { field: 61, value: writer.finish() };
  }
  return undefined;
}

function decodeEntry(bytes: Uint8Array): RemoteAgentPtyInventoryEntry {
  const value = {
    ptyId: "",
    requestDigest: new Uint8Array(),
    state: "",
    pid: 0,
    nextSequence: 0,
    firstRetainedSequence: 0,
    verifiedExit: false,
    launchStatus: "",
  };
  decodeMessage(bytes, (field, wireType, reader) => {
    switch (field) {
      case 1:
        requireWireType(wireType, 2);
        value.ptyId = reader.string();
        break;
      case 2:
        requireWireType(wireType, 2);
        value.requestDigest = new Uint8Array(reader.bytesValue());
        break;
      case 3:
        requireWireType(wireType, 2);
        value.state = reader.string();
        break;
      case 4:
        requireWireType(wireType, 0);
        value.pid = reader.uint();
        break;
      case 5:
        requireWireType(wireType, 0);
        value.nextSequence = reader.uint();
        break;
      case 6:
        requireWireType(wireType, 0);
        value.firstRetainedSequence = reader.uint();
        break;
      case 7:
        requireWireType(wireType, 0);
        value.verifiedExit = reader.uint() !== 0;
        break;
      case 8:
        requireWireType(wireType, 2);
        value.launchStatus = reader.string();
        break;
      default:
        reader.skip(wireType);
    }
  });
  return value;
}

function decodeRequest(bytes: Uint8Array): RemoteAgentPtyListRequest {
  const value = { requestId: "", expectedEpoch: "", afterPtyId: "", limit: 0, snapshotId: "" };
  decodeMessage(bytes, (field, wireType, reader) => {
    switch (field) {
      case 1:
        requireWireType(wireType, 2);
        value.requestId = reader.string();
        break;
      case 2:
        requireWireType(wireType, 2);
        value.expectedEpoch = reader.string();
        break;
      case 3:
        requireWireType(wireType, 2);
        value.afterPtyId = reader.string();
        break;
      case 4:
        requireWireType(wireType, 0);
        value.limit = reader.uint();
        break;
      case 5:
        requireWireType(wireType, 2);
        value.snapshotId = reader.string();
        break;
      default:
        reader.skip(wireType);
    }
  });
  return value;
}

function decodeResponse(bytes: Uint8Array): RemoteAgentPtyListResponse {
  const entries: RemoteAgentPtyInventoryEntry[] = [];
  const value = {
    requestId: "",
    agentEpoch: "",
    entries,
    nextAfterPtyId: "",
    snapshotId: "",
    accepted: false,
    errorCode: "",
  };
  decodeMessage(bytes, (field, wireType, reader) => {
    switch (field) {
      case 1:
        requireWireType(wireType, 2);
        value.requestId = reader.string();
        break;
      case 2:
        requireWireType(wireType, 2);
        value.agentEpoch = reader.string();
        break;
      case 3:
        requireWireType(wireType, 2);
        if (entries.length >= 100)
          throw new RemoteAgentProtocolDecodeError("PTY inventory page exceeds 100 entries");
        entries.push(decodeEntry(reader.bytesValue()));
        break;
      case 4:
        requireWireType(wireType, 2);
        value.nextAfterPtyId = reader.string();
        break;
      case 5:
        requireWireType(wireType, 2);
        value.snapshotId = reader.string();
        break;
      case 6:
        requireWireType(wireType, 0);
        value.accepted = reader.uint() !== 0;
        break;
      case 7:
        requireWireType(wireType, 2);
        value.errorCode = reader.string();
        break;
      default:
        reader.skip(wireType);
    }
  });
  return value;
}

export function decodePtyInventoryFrame(
  field: number,
  bytes: Uint8Array,
): RemoteAgentFrame | undefined {
  if (field === 60) return { type: "ptyListRequest", value: decodeRequest(bytes) };
  if (field === 61) return { type: "ptyListResponse", value: decodeResponse(bytes) };
  return undefined;
}
