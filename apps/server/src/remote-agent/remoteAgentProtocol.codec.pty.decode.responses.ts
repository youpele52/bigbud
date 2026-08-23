import {
  type RemoteAgentFrame,
  type RemoteAgentPtyAttachResponse,
  type RemoteAgentPtyControlResponse,
  type RemoteAgentPtyCreateResponse,
  type RemoteAgentPtyExited,
  type RemoteAgentPtyOutput,
  type RemoteAgentPtyResizeResponse,
  type RemoteAgentPtySignalResponse,
} from "./remoteAgentProtocol.ts";
import { decodeMessage, requireWireType } from "./remoteAgentProtocol.codec.wire.ts";

function decodeCreate(bytes: Uint8Array): RemoteAgentPtyCreateResponse {
  const value = {
    requestId: "",
    ptyId: "",
    accepted: false,
    pid: 0,
    errorCode: "",
    errorMessage: "",
  };
  decodeMessage(bytes, (field, wireType, reader) => {
    switch (field) {
      case 1:
        requireWireType(wireType, 2);
        value.requestId = reader.string();
        break;
      case 2:
        requireWireType(wireType, 2);
        value.ptyId = reader.string();
        break;
      case 3:
        requireWireType(wireType, 0);
        value.accepted = reader.uint() !== 0;
        break;
      case 4:
        requireWireType(wireType, 0);
        value.pid = reader.uint();
        break;
      case 5:
        requireWireType(wireType, 2);
        value.errorCode = reader.string();
        break;
      case 6:
        requireWireType(wireType, 2);
        value.errorMessage = reader.string();
        break;
      default:
        reader.skip(wireType);
    }
  });
  return value;
}

function decodeOutput(bytes: Uint8Array): RemoteAgentPtyOutput {
  const value = {
    ptyId: "",
    sequence: 0,
    bytes: new Uint8Array() as Uint8Array<ArrayBufferLike>,
  };
  decodeMessage(bytes, (field, wireType, reader) => {
    if (field === 1) {
      requireWireType(wireType, 2);
      value.ptyId = reader.string();
    } else if (field === 2) {
      requireWireType(wireType, 0);
      value.sequence = reader.uint();
    } else if (field === 3) {
      requireWireType(wireType, 2);
      value.bytes = reader.bytesValue();
    } else {
      reader.skip(wireType);
    }
  });
  return value;
}

function decodeResponse(bytes: Uint8Array): RemoteAgentPtyControlResponse {
  const value = { requestId: "", ptyId: "", accepted: false, errorCode: "", errorMessage: "" };
  decodeMessage(bytes, (field, wireType, reader) => {
    if (field === 1) {
      requireWireType(wireType, 2);
      value.requestId = reader.string();
    } else if (field === 2) {
      requireWireType(wireType, 2);
      value.ptyId = reader.string();
    } else if (field === 3) {
      requireWireType(wireType, 0);
      value.accepted = reader.uint() !== 0;
    } else if (field === 4) {
      requireWireType(wireType, 2);
      value.errorCode = reader.string();
    } else if (field === 5) {
      requireWireType(wireType, 2);
      value.errorMessage = reader.string();
    } else {
      reader.skip(wireType);
    }
  });
  return value;
}

function decodeAttach(bytes: Uint8Array): RemoteAgentPtyAttachResponse {
  const value = {
    requestId: "",
    ptyId: "",
    state: "",
    pid: 0,
    nextSequence: 0,
    firstRetainedSequence: 0,
    replayGap: false,
  };
  decodeMessage(bytes, (field, wireType, reader) => {
    switch (field) {
      case 1:
        requireWireType(wireType, 2);
        value.requestId = reader.string();
        break;
      case 2:
        requireWireType(wireType, 2);
        value.ptyId = reader.string();
        break;
      case 3:
        requireWireType(wireType, 2);
        value.state = reader.string();
        break;
      case 4:
      case 5:
      case 6:
        requireWireType(wireType, 0);
        if (field === 4) value.pid = reader.uint();
        else if (field === 5) value.nextSequence = reader.uint();
        else value.firstRetainedSequence = reader.uint();
        break;
      case 7:
        requireWireType(wireType, 0);
        value.replayGap = reader.uint() !== 0;
        break;
      default:
        reader.skip(wireType);
    }
  });
  return value;
}

function decodeExited(bytes: Uint8Array): RemoteAgentPtyExited {
  const value = { ptyId: "", exitCode: 0, hasExitCode: false, signal: 0, hasSignal: false };
  decodeMessage(bytes, (field, wireType, reader) => {
    if (field === 1) {
      requireWireType(wireType, 2);
      value.ptyId = reader.string();
    } else if (field >= 2 && field <= 5) {
      requireWireType(wireType, 0);
      if (field === 2) value.exitCode = toSigned32(reader.uint());
      else if (field === 3) value.hasExitCode = reader.uint() !== 0;
      else if (field === 4) value.signal = toSigned32(reader.uint());
      else value.hasSignal = reader.uint() !== 0;
    } else {
      reader.skip(wireType);
    }
  });
  return value;
}

function toSigned32(value: number): number {
  return value > 0x7fff_ffff ? value - 0x1_0000_0000 : value;
}

export function decodePtyResponse(field: number, bytes: Uint8Array): RemoteAgentFrame | undefined {
  switch (field) {
    case 43:
      return { type: "ptyCreateResponse", value: decodeCreate(bytes) };
    case 45:
      return { type: "ptyOutput", value: decodeOutput(bytes) };
    case 48:
      return {
        type: "ptyResizeResponse",
        value: decodeResponse(bytes) as RemoteAgentPtyResizeResponse,
      };
    case 50:
      return {
        type: "ptySignalResponse",
        value: decodeResponse(bytes) as RemoteAgentPtySignalResponse,
      };
    case 52:
      return { type: "ptyAttachResponse", value: decodeAttach(bytes) };
    case 54:
      return { type: "ptyCloseResponse", value: decodeResponse(bytes) };
    case 55:
      return { type: "ptyExited", value: decodeExited(bytes) };
    case 56:
      return { type: "ptyInputResponse", value: decodeResponse(bytes) };
    case 57:
      return { type: "ptyOutputAckResponse", value: decodeResponse(bytes) };
    default:
      return undefined;
  }
}
