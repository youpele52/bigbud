import {
  type RemoteAgentFrame,
  type RemoteAgentProcessEnvironment,
  type RemoteAgentPtyAttachRequest,
  type RemoteAgentPtyCloseRequest,
  type RemoteAgentPtyCreateRequest,
  type RemoteAgentPtyInput,
  type RemoteAgentPtyOutputAck,
  type RemoteAgentPtyResizeRequest,
  type RemoteAgentPtySignalRequest,
} from "./remoteAgentProtocol.ts";
import { decodeMessage, requireWireType } from "./remoteAgentProtocol.codec.wire.ts";

function decodeEnvironment(bytes: Uint8Array): RemoteAgentProcessEnvironment {
  const value = { name: "", value: "" };
  decodeMessage(bytes, (field, wireType, reader) => {
    if (field === 1) {
      requireWireType(wireType, 2);
      value.name = reader.string();
    } else if (field === 2) {
      requireWireType(wireType, 2);
      value.value = reader.string();
    } else {
      reader.skip(wireType);
    }
  });
  return value;
}

function decodeCreate(bytes: Uint8Array): RemoteAgentPtyCreateRequest {
  const value = {
    requestId: "",
    ptyId: "",
    requestDigest: new Uint8Array() as Uint8Array<ArrayBufferLike>,
    workspaceHandle: "",
    cwd: "",
    shell: "",
    args: [] as string[],
    cols: 0,
    rows: 0,
  };
  const environment: RemoteAgentProcessEnvironment[] = [];
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
        value.requestDigest = reader.bytesValue();
        break;
      case 4:
        requireWireType(wireType, 2);
        value.workspaceHandle = reader.string();
        break;
      case 5:
        requireWireType(wireType, 2);
        value.cwd = reader.string();
        break;
      case 6:
        requireWireType(wireType, 2);
        value.shell = reader.string();
        break;
      case 7:
        requireWireType(wireType, 2);
        value.args.push(reader.string());
        break;
      case 8:
        requireWireType(wireType, 0);
        value.cols = reader.uint();
        break;
      case 9:
        requireWireType(wireType, 0);
        value.rows = reader.uint();
        break;
      case 10:
        requireWireType(wireType, 2);
        environment.push(decodeEnvironment(reader.bytesValue()));
        break;
      default:
        reader.skip(wireType);
    }
  });
  return { ...value, ...(environment.length > 0 ? { environment } : {}) };
}

function decodeInput(bytes: Uint8Array): RemoteAgentPtyInput {
  const value = {
    requestId: "",
    ptyId: "",
    sequence: 0,
    bytes: new Uint8Array() as Uint8Array<ArrayBufferLike>,
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
        value.sequence = reader.uint();
        break;
      case 4:
        requireWireType(wireType, 2);
        value.bytes = reader.bytesValue();
        break;
      default:
        reader.skip(wireType);
    }
  });
  return value;
}

function decodeOutputAck(bytes: Uint8Array): RemoteAgentPtyOutputAck {
  const value = { requestId: "", ptyId: "", acknowledgedSequence: 0 };
  decodeMessage(bytes, (field, wireType, reader) => {
    if (field === 1) {
      requireWireType(wireType, 2);
      value.requestId = reader.string();
    } else if (field === 2) {
      requireWireType(wireType, 2);
      value.ptyId = reader.string();
    } else if (field === 3) {
      requireWireType(wireType, 0);
      value.acknowledgedSequence = reader.uint();
    } else {
      reader.skip(wireType);
    }
  });
  return value;
}

function decodeResize(bytes: Uint8Array): RemoteAgentPtyResizeRequest {
  const value = { requestId: "", ptyId: "", cols: 0, rows: 0 };
  decodeMessage(bytes, (field, wireType, reader) => {
    if (field === 1) {
      requireWireType(wireType, 2);
      value.requestId = reader.string();
    } else if (field === 2) {
      requireWireType(wireType, 2);
      value.ptyId = reader.string();
    } else if (field === 3) {
      requireWireType(wireType, 0);
      value.cols = reader.uint();
    } else if (field === 4) {
      requireWireType(wireType, 0);
      value.rows = reader.uint();
    } else {
      reader.skip(wireType);
    }
  });
  return value;
}

function decodeSignal(bytes: Uint8Array): RemoteAgentPtySignalRequest {
  const value = { requestId: "", ptyId: "", signal: "" };
  decodeMessage(bytes, (field, wireType, reader) => {
    if (field === 1) {
      requireWireType(wireType, 2);
      value.requestId = reader.string();
    } else if (field === 2) {
      requireWireType(wireType, 2);
      value.ptyId = reader.string();
    } else if (field === 3) {
      requireWireType(wireType, 2);
      value.signal = reader.string();
    } else {
      reader.skip(wireType);
    }
  });
  return value;
}

function decodeAttach(bytes: Uint8Array): RemoteAgentPtyAttachRequest {
  const value = { requestId: "", ptyId: "", afterSequence: 0 };
  decodeMessage(bytes, (field, wireType, reader) => {
    if (field === 1) {
      requireWireType(wireType, 2);
      value.requestId = reader.string();
    } else if (field === 2) {
      requireWireType(wireType, 2);
      value.ptyId = reader.string();
    } else if (field === 3) {
      requireWireType(wireType, 0);
      value.afterSequence = reader.uint();
    } else {
      reader.skip(wireType);
    }
  });
  return value;
}

function decodeClose(bytes: Uint8Array): RemoteAgentPtyCloseRequest {
  const value = { requestId: "", ptyId: "", terminate: false };
  decodeMessage(bytes, (field, wireType, reader) => {
    if (field === 1) {
      requireWireType(wireType, 2);
      value.requestId = reader.string();
    } else if (field === 2) {
      requireWireType(wireType, 2);
      value.ptyId = reader.string();
    } else if (field === 3) {
      requireWireType(wireType, 0);
      value.terminate = reader.uint() !== 0;
    } else {
      reader.skip(wireType);
    }
  });
  return value;
}

export function decodePtyRequest(field: number, bytes: Uint8Array): RemoteAgentFrame | undefined {
  switch (field) {
    case 42:
      return { type: "ptyCreateRequest", value: decodeCreate(bytes) };
    case 44:
      return { type: "ptyInput", value: decodeInput(bytes) };
    case 46:
      return { type: "ptyOutputAck", value: decodeOutputAck(bytes) };
    case 47:
      return { type: "ptyResizeRequest", value: decodeResize(bytes) };
    case 49:
      return { type: "ptySignalRequest", value: decodeSignal(bytes) };
    case 51:
      return { type: "ptyAttachRequest", value: decodeAttach(bytes) };
    case 53:
      return { type: "ptyCloseRequest", value: decodeClose(bytes) };
    default:
      return undefined;
  }
}
