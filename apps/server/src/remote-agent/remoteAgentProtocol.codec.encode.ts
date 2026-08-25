import {
  type RemoteAgentCapability,
  type RemoteAgentCancelRequest,
  type RemoteAgentCancelResponse,
  type RemoteAgentClientHello,
  type RemoteAgentDiagnosticRequest,
  type RemoteAgentDiagnosticResponse,
  type RemoteAgentFrame,
  type RemoteAgentHello,
  type RemoteAgentProtocolError,
} from "./remoteAgentProtocol.ts";
import { WireWriter } from "./remoteAgentProtocol.codec.wire.ts";
import { encodeWorkspaceFrame } from "./remoteAgentProtocol.codec.workspace.encode.ts";
import { encodeProcessFrame } from "./remoteAgentProtocol.codec.process.encode.ts";
import { encodePtyFrame } from "./remoteAgentProtocol.codec.pty.encode.ts";

function encodeClientHello(value: RemoteAgentClientHello): Uint8Array {
  const writer = new WireWriter();
  writer.fieldUint(1, value.protocolMajor);
  writer.fieldUint(2, value.protocolMinor);
  writer.fieldString(3, value.clientInstanceId);
  writer.fieldString(4, value.connectionId);
  writer.fieldString(5, value.serverNonce);
  writer.fieldUint(6, value.maxFrameBytes);
  return writer.finish();
}

function encodeCapability(value: RemoteAgentCapability): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.name);
  writer.fieldUint(2, value.major);
  writer.fieldUint(3, value.minor);
  return writer.finish();
}

function encodeAgentHello(value: RemoteAgentHello): Uint8Array {
  const writer = new WireWriter();
  writer.fieldUint(1, value.protocolMajor);
  writer.fieldUint(2, value.protocolMinor);
  writer.fieldString(3, value.agentVersion);
  writer.fieldString(4, value.buildDigest);
  writer.fieldString(5, value.os);
  writer.fieldString(6, value.architecture);
  writer.fieldString(7, value.agentInstanceId);
  writer.fieldString(8, value.agentEpoch);
  for (const capability of value.capabilities) {
    writer.fieldBytes(9, encodeCapability(capability));
  }
  writer.fieldUint(10, value.maxFrameBytes);
  writer.fieldUint(11, value.maxOperationOutputBytes);
  writer.fieldUint(12, value.maxJournalBytes);
  return writer.finish();
}

function encodeDiagnosticRequest(value: RemoteAgentDiagnosticRequest): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.operationId);
  writer.fieldBytes(3, value.requestDigest);
  writer.fieldString(4, value.workspaceHandle);
  writer.fieldUint(5, value.deadlineUnixMs);
  writer.fieldString(6, value.kind);
  return writer.finish();
}

function encodeDiagnosticResponse(value: RemoteAgentDiagnosticResponse): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.operationId);
  writer.fieldBool(3, value.accepted);
  writer.fieldBool(4, value.terminal);
  writer.fieldString(5, value.message);
  return writer.finish();
}

function encodeCancelRequest(value: RemoteAgentCancelRequest): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.operationId);
  return writer.finish();
}

function encodeCancelResponse(value: RemoteAgentCancelResponse): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.operationId);
  writer.fieldBool(3, value.cancelled);
  writer.fieldBool(4, value.terminal);
  writer.fieldString(5, value.detail);
  return writer.finish();
}

function encodeProtocolError(value: RemoteAgentProtocolError): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.code);
  writer.fieldString(3, value.message);
  return writer.finish();
}

export function encodeFramePayload(frame: RemoteAgentFrame): Uint8Array {
  const writer = new WireWriter();
  const workspaceFrame = encodeWorkspaceFrame(frame);
  if (workspaceFrame) {
    writer.fieldBytes(workspaceFrame.field, workspaceFrame.value);
    return writer.finish();
  }
  const processFrame = encodeProcessFrame(frame);
  if (processFrame) {
    writer.fieldBytes(processFrame.field, processFrame.value);
    return writer.finish();
  }
  const ptyFrame = encodePtyFrame(frame);
  if (ptyFrame) {
    writer.fieldBytes(ptyFrame.field, ptyFrame.value);
    return writer.finish();
  }
  switch (frame.type) {
    case "clientHello":
      writer.fieldBytes(1, encodeClientHello(frame.value));
      break;
    case "agentHello":
      writer.fieldBytes(2, encodeAgentHello(frame.value));
      break;
    case "diagnosticRequest":
      writer.fieldBytes(3, encodeDiagnosticRequest(frame.value));
      break;
    case "diagnosticResponse":
      writer.fieldBytes(4, encodeDiagnosticResponse(frame.value));
      break;
    case "cancelRequest":
      writer.fieldBytes(5, encodeCancelRequest(frame.value));
      break;
    case "cancelResponse":
      writer.fieldBytes(6, encodeCancelResponse(frame.value));
      break;
    case "protocolError":
      writer.fieldBytes(7, encodeProtocolError(frame.value));
      break;
  }
  return writer.finish();
}
