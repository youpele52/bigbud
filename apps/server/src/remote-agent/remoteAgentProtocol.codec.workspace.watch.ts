import type {
  RemoteAgentFrame,
  RemoteAgentWorkspaceChange,
  RemoteAgentWorkspaceWatchEvent,
  RemoteAgentWorkspaceWatchStartRequest,
  RemoteAgentWorkspaceWatchStartResponse,
  RemoteAgentWorkspaceWatchStopRequest,
  RemoteAgentWorkspaceWatchStopResponse,
} from "./remoteAgentProtocol.ts";
import { decodeMessage, requireWireType, WireWriter } from "./remoteAgentProtocol.codec.wire.ts";

function encodeStartRequest(value: RemoteAgentWorkspaceWatchStartRequest): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.subscriptionId);
  writer.fieldString(3, value.workspaceHandle);
  writer.fieldString(4, value.path);
  return writer.finish();
}

function encodeStartResponse(value: RemoteAgentWorkspaceWatchStartResponse): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.subscriptionId);
  writer.fieldBool(3, value.accepted);
  writer.fieldUint(4, value.generation);
  writer.fieldString(5, value.backend);
  writer.fieldString(6, value.errorCode);
  writer.fieldString(7, value.errorMessage);
  return writer.finish();
}

function encodeChange(value: RemoteAgentWorkspaceChange): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.path);
  writer.fieldString(2, value.kind);
  return writer.finish();
}

function encodeEvent(value: RemoteAgentWorkspaceWatchEvent): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.subscriptionId);
  writer.fieldUint(2, value.generation);
  writer.fieldUint(3, value.sequence);
  for (const change of value.changes) writer.fieldBytes(4, encodeChange(change));
  writer.fieldBool(5, value.rescanRequired);
  writer.fieldString(6, value.rescanReason);
  writer.fieldString(7, value.backend);
  return writer.finish();
}

function encodeStopRequest(value: RemoteAgentWorkspaceWatchStopRequest): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.subscriptionId);
  return writer.finish();
}

function encodeStopResponse(value: RemoteAgentWorkspaceWatchStopResponse): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.subscriptionId);
  writer.fieldBool(3, value.stopped);
  return writer.finish();
}

export function encodeWorkspaceWatchFrame(
  frame: RemoteAgentFrame,
): { readonly field: number; readonly value: Uint8Array } | undefined {
  switch (frame.type) {
    case "workspaceWatchStartRequest":
      return { field: 28, value: encodeStartRequest(frame.value) };
    case "workspaceWatchStartResponse":
      return { field: 29, value: encodeStartResponse(frame.value) };
    case "workspaceWatchEvent":
      return { field: 30, value: encodeEvent(frame.value) };
    case "workspaceWatchStopRequest":
      return { field: 31, value: encodeStopRequest(frame.value) };
    case "workspaceWatchStopResponse":
      return { field: 32, value: encodeStopResponse(frame.value) };
    default:
      return undefined;
  }
}

function decodeStartRequest(bytes: Uint8Array): RemoteAgentWorkspaceWatchStartRequest {
  const value = { requestId: "", subscriptionId: "", workspaceHandle: "", path: "" };
  decodeMessage(bytes, (field, wireType, reader) => {
    requireWireType(wireType, 2);
    if (field === 1) value.requestId = reader.string();
    else if (field === 2) value.subscriptionId = reader.string();
    else if (field === 3) value.workspaceHandle = reader.string();
    else if (field === 4) value.path = reader.string();
    else reader.skip(wireType);
  });
  return value;
}

function decodeStartResponse(bytes: Uint8Array): RemoteAgentWorkspaceWatchStartResponse {
  const value = {
    requestId: "",
    subscriptionId: "",
    accepted: false,
    generation: 0,
    backend: "",
    errorCode: "",
    errorMessage: "",
  };
  decodeMessage(bytes, (field, wireType, reader) => {
    if (field === 3 || field === 4) {
      requireWireType(wireType, 0);
      const decoded = reader.uint();
      if (field === 3) value.accepted = decoded !== 0;
      else value.generation = decoded;
      return;
    }
    requireWireType(wireType, 2);
    if (field === 1) value.requestId = reader.string();
    else if (field === 2) value.subscriptionId = reader.string();
    else if (field === 5) value.backend = reader.string();
    else if (field === 6) value.errorCode = reader.string();
    else if (field === 7) value.errorMessage = reader.string();
    else reader.skip(wireType);
  });
  return value;
}

function decodeChange(bytes: Uint8Array): RemoteAgentWorkspaceChange {
  const value: { path: string; kind: RemoteAgentWorkspaceChange["kind"] } = {
    path: "",
    kind: "unknown",
  };
  decodeMessage(bytes, (field, wireType, reader) => {
    requireWireType(wireType, 2);
    if (field === 1) value.path = reader.string();
    else if (field === 2) {
      const kind = reader.string();
      if (kind === "create" || kind === "modify" || kind === "remove") value.kind = kind;
    } else reader.skip(wireType);
  });
  return value;
}

function decodeEvent(bytes: Uint8Array): RemoteAgentWorkspaceWatchEvent {
  const value = {
    subscriptionId: "",
    generation: 0,
    sequence: 0,
    changes: [] as RemoteAgentWorkspaceChange[],
    rescanRequired: false,
    rescanReason: "",
    backend: "",
  };
  decodeMessage(bytes, (field, wireType, reader) => {
    if (field === 2 || field === 3 || field === 5) {
      requireWireType(wireType, 0);
      const decoded = reader.uint();
      if (field === 2) value.generation = decoded;
      else if (field === 3) value.sequence = decoded;
      else value.rescanRequired = decoded !== 0;
      return;
    }
    requireWireType(wireType, 2);
    if (field === 1) value.subscriptionId = reader.string();
    else if (field === 4) value.changes.push(decodeChange(reader.bytesValue()));
    else if (field === 6) value.rescanReason = reader.string();
    else if (field === 7) value.backend = reader.string();
    else reader.skip(wireType);
  });
  return value;
}

function decodeStopRequest(bytes: Uint8Array): RemoteAgentWorkspaceWatchStopRequest {
  const value = { requestId: "", subscriptionId: "" };
  decodeMessage(bytes, (field, wireType, reader) => {
    requireWireType(wireType, 2);
    if (field === 1) value.requestId = reader.string();
    else if (field === 2) value.subscriptionId = reader.string();
    else reader.skip(wireType);
  });
  return value;
}

function decodeStopResponse(bytes: Uint8Array): RemoteAgentWorkspaceWatchStopResponse {
  const value = { requestId: "", subscriptionId: "", stopped: false };
  decodeMessage(bytes, (field, wireType, reader) => {
    if (field === 3) {
      requireWireType(wireType, 0);
      value.stopped = reader.uint() !== 0;
    } else {
      requireWireType(wireType, 2);
      if (field === 1) value.requestId = reader.string();
      else if (field === 2) value.subscriptionId = reader.string();
      else reader.skip(wireType);
    }
  });
  return value;
}

export function decodeWorkspaceWatchFrame(
  field: number,
  bytes: Uint8Array,
): RemoteAgentFrame | undefined {
  if (field === 28) return { type: "workspaceWatchStartRequest", value: decodeStartRequest(bytes) };
  if (field === 29)
    return { type: "workspaceWatchStartResponse", value: decodeStartResponse(bytes) };
  if (field === 30) return { type: "workspaceWatchEvent", value: decodeEvent(bytes) };
  if (field === 31) return { type: "workspaceWatchStopRequest", value: decodeStopRequest(bytes) };
  if (field === 32) return { type: "workspaceWatchStopResponse", value: decodeStopResponse(bytes) };
  return undefined;
}
