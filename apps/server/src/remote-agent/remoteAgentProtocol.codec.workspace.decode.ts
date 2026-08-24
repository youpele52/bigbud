import {
  type RemoteAgentFilenameSearchRequest,
  type RemoteAgentFrame,
  type RemoteAgentListDirectoryRequest,
  type RemoteAgentReadFileRequest,
  type RemoteAgentReadFileResponse,
  type RemoteAgentWorkspaceOpenRequest,
  type RemoteAgentWorkspaceOpenResponse,
} from "./remoteAgentProtocol.ts";
import { decodeMessage, requireWireType } from "./remoteAgentProtocol.codec.wire.ts";
import {
  decodeFilenameSearchResponse,
  decodeListDirectoryResponse,
} from "./remoteAgentProtocol.codec.workspace.decode.entries.ts";
import {
  decodeContentSearchRequest,
  decodeContentSearchResponse,
} from "./remoteAgentProtocol.codec.workspace.decode.content.ts";
import {
  decodeWriteFileRequest,
  decodeWriteFileResponse,
} from "./remoteAgentProtocol.codec.workspace.decode.write.ts";
import { decodeWorkspaceWatchFrame } from "./remoteAgentProtocol.codec.workspace.watch.ts";

type MutableOperationRequest = {
  requestId: string;
  operationId: string;
  requestDigest: Uint8Array<ArrayBufferLike>;
  workspaceHandle: string;
  path: string;
};

function decodeOperationRequest(
  bytes: Uint8Array,
  value: MutableOperationRequest,
  extra: (
    field: number,
    wireType: number,
    value: MutableOperationRequest,
    reader: Parameters<Parameters<typeof decodeMessage>[1]>[2],
  ) => void,
): void {
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
        value.path = reader.string();
        break;
      default:
        extra(field, wireType, value, reader);
    }
  });
}

function decodeWorkspaceOpenRequest(bytes: Uint8Array): RemoteAgentWorkspaceOpenRequest {
  const value = { requestId: "", workspaceHandle: "", root: "" };
  decodeMessage(bytes, (field, wireType, reader) => {
    switch (field) {
      case 1:
        requireWireType(wireType, 2);
        value.requestId = reader.string();
        break;
      case 2:
        requireWireType(wireType, 2);
        value.workspaceHandle = reader.string();
        break;
      case 3:
        requireWireType(wireType, 2);
        value.root = reader.string();
        break;
      default:
        reader.skip(wireType);
    }
  });
  return value;
}

function decodeWorkspaceOpenResponse(bytes: Uint8Array): RemoteAgentWorkspaceOpenResponse {
  const value = {
    requestId: "",
    workspaceHandle: "",
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
        value.workspaceHandle = reader.string();
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

function decodeReadFileRequest(bytes: Uint8Array): RemoteAgentReadFileRequest {
  const value = {
    requestId: "",
    operationId: "",
    requestDigest: new Uint8Array() as Uint8Array<ArrayBufferLike>,
    workspaceHandle: "",
    path: "",
    offset: 0,
    maxBytes: 0,
  };
  decodeOperationRequest(bytes, value, (field, wireType, _value, reader) => {
    switch (field) {
      case 6:
        requireWireType(wireType, 0);
        value.offset = reader.uint();
        break;
      case 7:
        requireWireType(wireType, 0);
        value.maxBytes = reader.uint();
        break;
      default:
        reader.skip(wireType);
    }
  });
  return value;
}

function decodeReadFileResponse(bytes: Uint8Array): RemoteAgentReadFileResponse {
  const value = {
    requestId: "",
    operationId: "",
    terminal: false,
    bytes: new Uint8Array() as Uint8Array<ArrayBufferLike>,
    totalBytes: 0,
    truncated: false,
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
        value.terminal = reader.uint() !== 0;
        break;
      case 4:
        requireWireType(wireType, 2);
        value.bytes = reader.bytesValue();
        break;
      case 5:
        requireWireType(wireType, 0);
        value.totalBytes = reader.uint();
        break;
      case 6:
        requireWireType(wireType, 0);
        value.truncated = reader.uint() !== 0;
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

function decodeListDirectoryRequest(bytes: Uint8Array): RemoteAgentListDirectoryRequest {
  const value = {
    requestId: "",
    operationId: "",
    requestDigest: new Uint8Array() as Uint8Array<ArrayBufferLike>,
    workspaceHandle: "",
    path: "",
  };
  decodeOperationRequest(bytes, value, (_field, wireType, _value, reader) => reader.skip(wireType));
  return value;
}

function decodeFilenameSearchRequest(bytes: Uint8Array): RemoteAgentFilenameSearchRequest {
  const value = {
    requestId: "",
    operationId: "",
    requestDigest: new Uint8Array() as Uint8Array<ArrayBufferLike>,
    workspaceHandle: "",
    path: "",
    query: "",
    maxResults: 0,
  };
  decodeOperationRequest(bytes, value, (field, wireType, _value, reader) => {
    switch (field) {
      case 6:
        requireWireType(wireType, 2);
        value.query = reader.string();
        break;
      case 7:
        requireWireType(wireType, 0);
        value.maxResults = reader.uint();
        break;
      default:
        reader.skip(wireType);
    }
  });
  return value;
}

export function decodeWorkspaceFrame(
  field: number,
  bytes: Uint8Array,
): RemoteAgentFrame | undefined {
  const watchFrame = decodeWorkspaceWatchFrame(field, bytes);
  if (watchFrame) return watchFrame;
  switch (field) {
    case 8:
      return { type: "workspaceOpenRequest", value: decodeWorkspaceOpenRequest(bytes) };
    case 9:
      return { type: "workspaceOpenResponse", value: decodeWorkspaceOpenResponse(bytes) };
    case 10:
      return { type: "readFileRequest", value: decodeReadFileRequest(bytes) };
    case 11:
      return { type: "readFileResponse", value: decodeReadFileResponse(bytes) };
    case 12:
      return { type: "listDirectoryRequest", value: decodeListDirectoryRequest(bytes) };
    case 13:
      return { type: "listDirectoryResponse", value: decodeListDirectoryResponse(bytes) };
    case 14:
      return { type: "filenameSearchRequest", value: decodeFilenameSearchRequest(bytes) };
    case 15:
      return { type: "filenameSearchResponse", value: decodeFilenameSearchResponse(bytes) };
    case 16:
      return { type: "contentSearchRequest", value: decodeContentSearchRequest(bytes) };
    case 17:
      return { type: "contentSearchResponse", value: decodeContentSearchResponse(bytes) };
    case 26:
      return { type: "writeFileRequest", value: decodeWriteFileRequest(bytes) };
    case 27:
      return { type: "writeFileResponse", value: decodeWriteFileResponse(bytes) };
    default:
      return undefined;
  }
}
