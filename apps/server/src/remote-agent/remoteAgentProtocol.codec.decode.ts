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
  RemoteAgentProtocolDecodeError,
} from "./remoteAgentProtocol.ts";
import { decodeMessage, requireWireType } from "./remoteAgentProtocol.codec.wire.ts";
import { decodeWorkspaceFrame } from "./remoteAgentProtocol.codec.workspace.decode.ts";
import { decodeProcessFrame } from "./remoteAgentProtocol.codec.process.decode.ts";
import { decodePtyFrame } from "./remoteAgentProtocol.codec.pty.decode.ts";

function decodeClientHello(bytes: Uint8Array): RemoteAgentClientHello {
  const value = {
    protocolMajor: 0,
    protocolMinor: 0,
    clientInstanceId: "",
    connectionId: "",
    serverNonce: "",
    maxFrameBytes: 0,
  };
  decodeMessage(bytes, (field, wireType, reader) => {
    switch (field) {
      case 1:
        requireWireType(wireType, 0);
        value.protocolMajor = reader.uint();
        break;
      case 2:
        requireWireType(wireType, 0);
        value.protocolMinor = reader.uint();
        break;
      case 3:
        requireWireType(wireType, 2);
        value.clientInstanceId = reader.string();
        break;
      case 4:
        requireWireType(wireType, 2);
        value.connectionId = reader.string();
        break;
      case 5:
        requireWireType(wireType, 2);
        value.serverNonce = reader.string();
        break;
      case 6:
        requireWireType(wireType, 0);
        value.maxFrameBytes = reader.uint();
        break;
      default:
        reader.skip(wireType);
    }
  });
  return value;
}

function decodeCapability(bytes: Uint8Array): RemoteAgentCapability {
  const value = { name: "", major: 0, minor: 0 };
  decodeMessage(bytes, (field, wireType, reader) => {
    switch (field) {
      case 1:
        requireWireType(wireType, 2);
        value.name = reader.string();
        break;
      case 2:
        requireWireType(wireType, 0);
        value.major = reader.uint();
        break;
      case 3:
        requireWireType(wireType, 0);
        value.minor = reader.uint();
        break;
      default:
        reader.skip(wireType);
    }
  });
  return value;
}

function decodeAgentHello(bytes: Uint8Array): RemoteAgentHello {
  const value = {
    protocolMajor: 0,
    protocolMinor: 0,
    agentVersion: "",
    buildDigest: "",
    os: "",
    architecture: "",
    agentInstanceId: "",
    agentEpoch: "",
    capabilities: [] as RemoteAgentCapability[],
    maxFrameBytes: 0,
    maxOperationOutputBytes: 0,
    maxJournalBytes: 0,
  };
  decodeMessage(bytes, (field, wireType, reader) => {
    switch (field) {
      case 1:
        requireWireType(wireType, 0);
        value.protocolMajor = reader.uint();
        break;
      case 2:
        requireWireType(wireType, 0);
        value.protocolMinor = reader.uint();
        break;
      case 3:
        requireWireType(wireType, 2);
        value.agentVersion = reader.string();
        break;
      case 4:
        requireWireType(wireType, 2);
        value.buildDigest = reader.string();
        break;
      case 5:
        requireWireType(wireType, 2);
        value.os = reader.string();
        break;
      case 6:
        requireWireType(wireType, 2);
        value.architecture = reader.string();
        break;
      case 7:
        requireWireType(wireType, 2);
        value.agentInstanceId = reader.string();
        break;
      case 8:
        requireWireType(wireType, 2);
        value.agentEpoch = reader.string();
        break;
      case 9:
        requireWireType(wireType, 2);
        value.capabilities.push(decodeCapability(reader.bytesValue()));
        break;
      case 10:
        requireWireType(wireType, 0);
        value.maxFrameBytes = reader.uint();
        break;
      case 11:
        requireWireType(wireType, 0);
        value.maxOperationOutputBytes = reader.uint();
        break;
      case 12:
        requireWireType(wireType, 0);
        value.maxJournalBytes = reader.uint();
        break;
      default:
        reader.skip(wireType);
    }
  });
  return value;
}

function decodeDiagnosticRequest(bytes: Uint8Array): RemoteAgentDiagnosticRequest {
  const value = {
    requestId: "",
    operationId: "",
    requestDigest: new Uint8Array() as Uint8Array<ArrayBufferLike>,
    workspaceHandle: "",
    deadlineUnixMs: 0,
    kind: "",
  };
  decodeMessage(bytes, (field, wireType, reader) => {
    switch (field) {
      case 1:
        requireWireType(wireType, 2);
        value.requestId = reader.string();
        break;
      case 2:
        requireWireType(wireType, 2);
        value.operationId = reader.string();
        break;
      case 3:
        requireWireType(wireType, 2);
        value.requestDigest = reader.bytesValue();
        break;
      case 4:
        requireWireType(wireType, 2);
        value.workspaceHandle = reader.string();
        break;
      case 5:
        requireWireType(wireType, 0);
        value.deadlineUnixMs = reader.uint();
        break;
      case 6:
        requireWireType(wireType, 2);
        value.kind = reader.string();
        break;
      default:
        reader.skip(wireType);
    }
  });
  return value;
}

function decodeDiagnosticResponse(bytes: Uint8Array): RemoteAgentDiagnosticResponse {
  const value = {
    requestId: "",
    operationId: "",
    accepted: false,
    terminal: false,
    message: "",
  };
  decodeMessage(bytes, (field, wireType, reader) => {
    switch (field) {
      case 1:
        requireWireType(wireType, 2);
        value.requestId = reader.string();
        break;
      case 2:
        requireWireType(wireType, 2);
        value.operationId = reader.string();
        break;
      case 3:
        requireWireType(wireType, 0);
        value.accepted = reader.uint() !== 0;
        break;
      case 4:
        requireWireType(wireType, 0);
        value.terminal = reader.uint() !== 0;
        break;
      case 5:
        requireWireType(wireType, 2);
        value.message = reader.string();
        break;
      default:
        reader.skip(wireType);
    }
  });
  return value;
}

function decodeCancelRequest(bytes: Uint8Array): RemoteAgentCancelRequest {
  const value = { requestId: "", operationId: "" };
  decodeMessage(bytes, (field, wireType, reader) => {
    switch (field) {
      case 1:
        requireWireType(wireType, 2);
        value.requestId = reader.string();
        break;
      case 2:
        requireWireType(wireType, 2);
        value.operationId = reader.string();
        break;
      default:
        reader.skip(wireType);
    }
  });
  return value;
}

function decodeCancelResponse(bytes: Uint8Array): RemoteAgentCancelResponse {
  const value = {
    requestId: "",
    operationId: "",
    cancelled: false,
    terminal: false,
    detail: "",
  };
  decodeMessage(bytes, (field, wireType, reader) => {
    switch (field) {
      case 1:
        requireWireType(wireType, 2);
        value.requestId = reader.string();
        break;
      case 2:
        requireWireType(wireType, 2);
        value.operationId = reader.string();
        break;
      case 3:
        requireWireType(wireType, 0);
        value.cancelled = reader.uint() !== 0;
        break;
      case 4:
        requireWireType(wireType, 0);
        value.terminal = reader.uint() !== 0;
        break;
      case 5:
        requireWireType(wireType, 2);
        value.detail = reader.string();
        break;
      default:
        reader.skip(wireType);
    }
  });
  return value;
}

function decodeProtocolError(bytes: Uint8Array): RemoteAgentProtocolError {
  const value = { requestId: "", code: "", message: "" };
  decodeMessage(bytes, (field, wireType, reader) => {
    switch (field) {
      case 1:
        requireWireType(wireType, 2);
        value.requestId = reader.string();
        break;
      case 2:
        requireWireType(wireType, 2);
        value.code = reader.string();
        break;
      case 3:
        requireWireType(wireType, 2);
        value.message = reader.string();
        break;
      default:
        reader.skip(wireType);
    }
  });
  return value;
}

export function decodeFramePayload(bytes: Uint8Array): RemoteAgentFrame {
  let frame: RemoteAgentFrame | undefined;
  decodeMessage(bytes, (field, wireType, reader) => {
    if (field > 7) {
      if (!((field >= 8 && field <= 27) || (field >= 42 && field <= 57))) {
        reader.skip(wireType);
        return;
      }
      requireWireType(wireType, 2);
      const payload = reader.bytesValue();
      const workspaceFrame = decodeWorkspaceFrame(field, payload);
      const processFrame = decodeProcessFrame(field, payload);
      const ptyFrame = decodePtyFrame(field, payload);
      const decodedFrame = workspaceFrame ?? processFrame ?? ptyFrame;
      if (!decodedFrame) return;
      if (frame) {
        throw new RemoteAgentProtocolDecodeError("protobuf frame contains multiple payloads");
      }
      frame = decodedFrame;
      return;
    }
    if (field < 1) {
      reader.skip(wireType);
      return;
    }
    requireWireType(wireType, 2);
    if (frame) {
      throw new RemoteAgentProtocolDecodeError("protobuf frame contains multiple payloads");
    }
    const value = reader.bytesValue();
    frame =
      field === 1
        ? { type: "clientHello", value: decodeClientHello(value) }
        : field === 2
          ? { type: "agentHello", value: decodeAgentHello(value) }
          : field === 3
            ? { type: "diagnosticRequest", value: decodeDiagnosticRequest(value) }
            : field === 4
              ? { type: "diagnosticResponse", value: decodeDiagnosticResponse(value) }
              : field === 5
                ? { type: "cancelRequest", value: decodeCancelRequest(value) }
                : field === 6
                  ? { type: "cancelResponse", value: decodeCancelResponse(value) }
                  : { type: "protocolError", value: decodeProtocolError(value) };
  });
  if (!frame) {
    throw new RemoteAgentProtocolDecodeError("protobuf frame has no known payload");
  }
  return frame;
}
