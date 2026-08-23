import {
  RemoteAgentProtocolDecodeError,
  type RemoteAgentFrame,
  type RemoteAgentProcessAccepted,
  type RemoteAgentProcessAttachRequest,
  type RemoteAgentProcessAttachResponse,
  type RemoteAgentProcessCompleted,
  type RemoteAgentProcessOutput,
  type RemoteAgentProcessAckResponse,
  type RemoteAgentProcessEnvironment,
  type RemoteAgentProcessOutputAck,
  type RemoteAgentProcessRequest,
} from "./remoteAgentProtocol.ts";
import { decodeMessage, requireWireType } from "./remoteAgentProtocol.codec.wire.ts";

function decodeProcessRequest(bytes: Uint8Array): RemoteAgentProcessRequest {
  const value = {
    requestId: "",
    operationId: "",
    requestDigest: new Uint8Array() as Uint8Array<ArrayBufferLike>,
    workspaceHandle: "",
    command: "",
    args: [] as string[],
    timeoutMs: 0,
    maxOutputBytes: 0,
  };
  const environment: RemoteAgentProcessEnvironment[] = [];
  let stdin: Uint8Array<ArrayBufferLike> | undefined;
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
        requireWireType(wireType, 2);
        value.command = reader.string();
        break;
      case 6:
        requireWireType(wireType, 2);
        value.args.push(reader.string());
        break;
      case 7:
        requireWireType(wireType, 0);
        value.timeoutMs = reader.uint();
        break;
      case 8:
        requireWireType(wireType, 0);
        value.maxOutputBytes = reader.uint();
        break;
      case 9:
        requireWireType(wireType, 2);
        environment.push(decodeProcessEnvironment(reader.bytesValue()));
        break;
      case 10:
        requireWireType(wireType, 2);
        stdin = reader.bytesValue();
        break;
      default:
        reader.skip(wireType);
    }
  });
  return {
    ...value,
    ...(environment.length > 0 ? { environment } : {}),
    ...(stdin !== undefined ? { stdin } : {}),
  };
}

function decodeProcessEnvironment(bytes: Uint8Array): RemoteAgentProcessEnvironment {
  const value = { name: "", value: "" };
  decodeMessage(bytes, (field, wireType, reader) => {
    switch (field) {
      case 1:
        requireWireType(wireType, 2);
        value.name = reader.string();
        break;
      case 2:
        requireWireType(wireType, 2);
        value.value = reader.string();
        break;
      default:
        reader.skip(wireType);
    }
  });
  return value;
}

function decodeProcessAccepted(bytes: Uint8Array): RemoteAgentProcessAccepted {
  const value = {
    requestId: "",
    operationId: "",
    accepted: false,
    duplicate: false,
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
        value.operationId = reader.string();
        break;
      case 3:
        requireWireType(wireType, 0);
        value.accepted = reader.uint() !== 0;
        break;
      case 4:
        requireWireType(wireType, 0);
        value.duplicate = reader.uint() !== 0;
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

function decodeProcessOutput(bytes: Uint8Array): RemoteAgentProcessOutput {
  const value = {
    operationId: "",
    sequence: 0,
    stream: "stdout" as "stdout" | "stderr",
    bytes: new Uint8Array() as Uint8Array<ArrayBufferLike>,
  };
  decodeMessage(bytes, (field, wireType, reader) => {
    switch (field) {
      case 1:
        requireWireType(wireType, 2);
        value.operationId = reader.string();
        break;
      case 2:
        requireWireType(wireType, 0);
        value.sequence = reader.uint();
        break;
      case 3: {
        requireWireType(wireType, 2);
        const stream = reader.string();
        if (stream !== "stdout" && stream !== "stderr") {
          throw new RemoteAgentProtocolDecodeError(`Unknown process output stream '${stream}'.`);
        }
        value.stream = stream;
        break;
      }
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

function decodeProcessCompleted(bytes: Uint8Array): RemoteAgentProcessCompleted {
  const value = {
    requestId: "",
    operationId: "",
    state: "",
    hasExitCode: false,
    exitCode: 0,
    outputTruncated: false,
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
        value.operationId = reader.string();
        break;
      case 3:
        requireWireType(wireType, 2);
        value.state = reader.string();
        break;
      case 4:
        requireWireType(wireType, 0);
        value.hasExitCode = reader.uint() !== 0;
        break;
      case 5: {
        requireWireType(wireType, 0);
        const code = reader.uint();
        value.exitCode = code > 0x7fff_ffff ? code - 0x1_0000_0000 : code;
        break;
      }
      case 6:
        requireWireType(wireType, 0);
        value.outputTruncated = reader.uint() !== 0;
        break;
      case 7:
        requireWireType(wireType, 2);
        value.errorCode = reader.string();
        break;
      case 8:
        requireWireType(wireType, 2);
        value.errorMessage = reader.string();
        break;
      default:
        reader.skip(wireType);
    }
  });
  return value;
}

function decodeProcessAttachRequest(bytes: Uint8Array): RemoteAgentProcessAttachRequest {
  const value = { requestId: "", operationId: "", afterSequence: 0 };
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
        value.afterSequence = reader.uint();
        break;
      default:
        reader.skip(wireType);
    }
  });
  return value;
}

function decodeProcessOutputAck(bytes: Uint8Array): RemoteAgentProcessOutputAck {
  const value = { requestId: "", operationId: "", acknowledgedSequence: 0 };
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
        value.acknowledgedSequence = reader.uint();
        break;
      default:
        reader.skip(wireType);
    }
  });
  return value;
}

function decodeProcessAckResponse(bytes: Uint8Array): RemoteAgentProcessAckResponse {
  const value = {
    requestId: "",
    operationId: "",
    accepted: false,
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
        value.operationId = reader.string();
        break;
      case 3:
        requireWireType(wireType, 0);
        value.accepted = reader.uint() !== 0;
        break;
      case 4:
        requireWireType(wireType, 2);
        value.errorCode = reader.string();
        break;
      case 5:
        requireWireType(wireType, 2);
        value.errorMessage = reader.string();
        break;
      default:
        reader.skip(wireType);
    }
  });
  return value;
}

function decodeProcessAttachResponse(bytes: Uint8Array): RemoteAgentProcessAttachResponse {
  const value = {
    requestId: "",
    operationId: "",
    state: "",
    nextSequence: 0,
    firstRetainedSequence: 0,
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
        value.state = reader.string();
        break;
      case 4:
        requireWireType(wireType, 0);
        value.nextSequence = reader.uint();
        break;
      case 5:
        requireWireType(wireType, 0);
        value.firstRetainedSequence = reader.uint();
        break;
      default:
        reader.skip(wireType);
    }
  });
  return value;
}

export function decodeProcessFrame(field: number, bytes: Uint8Array): RemoteAgentFrame | undefined {
  switch (field) {
    case 18:
      return { type: "processRequest", value: decodeProcessRequest(bytes) };
    case 19:
      return { type: "processAccepted", value: decodeProcessAccepted(bytes) };
    case 20:
      return { type: "processOutput", value: decodeProcessOutput(bytes) };
    case 21:
      return { type: "processCompleted", value: decodeProcessCompleted(bytes) };
    case 22:
      return { type: "processAttachRequest", value: decodeProcessAttachRequest(bytes) };
    case 23:
      return { type: "processOutputAck", value: decodeProcessOutputAck(bytes) };
    case 24:
      return { type: "processAckResponse", value: decodeProcessAckResponse(bytes) };
    case 25:
      return { type: "processAttachResponse", value: decodeProcessAttachResponse(bytes) };
    default:
      return undefined;
  }
}
