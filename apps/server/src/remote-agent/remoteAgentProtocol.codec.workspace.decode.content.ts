import {
  type RemoteAgentContentMatch,
  type RemoteAgentContentSearchRequest,
  type RemoteAgentContentSearchResponse,
} from "./remoteAgentProtocol.ts";
import { decodeMessage, requireWireType } from "./remoteAgentProtocol.codec.wire.ts";

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
        extra(field, wireType, reader);
    }
  });
}

export function decodeContentSearchRequest(bytes: Uint8Array): RemoteAgentContentSearchRequest {
  const value = {
    requestId: "",
    operationId: "",
    requestDigest: new Uint8Array() as Uint8Array<ArrayBufferLike>,
    workspaceHandle: "",
    path: "",
    query: "",
    maxResults: 0,
  };
  decodeOperationRequest(bytes, value, (field, wireType, reader) => {
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

function decodeContentMatch(bytes: Uint8Array): RemoteAgentContentMatch {
  const value = { path: "", line: 0, column: 0, excerpt: "" };
  decodeMessage(bytes, (field, wireType, reader) => {
    switch (field) {
      case 1:
        requireWireType(wireType, 2);
        value.path = reader.string();
        break;
      case 2:
        requireWireType(wireType, 0);
        value.line = reader.uint();
        break;
      case 3:
        requireWireType(wireType, 0);
        value.column = reader.uint();
        break;
      case 4:
        requireWireType(wireType, 2);
        value.excerpt = reader.string();
        break;
      default:
        reader.skip(wireType);
    }
  });
  return value;
}

export function decodeContentSearchResponse(bytes: Uint8Array): RemoteAgentContentSearchResponse {
  const value = {
    requestId: "",
    operationId: "",
    terminal: false,
    matches: [] as RemoteAgentContentMatch[],
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
        value.matches.push(decodeContentMatch(reader.bytesValue()));
        break;
      case 5:
        requireWireType(wireType, 0);
        value.truncated = reader.uint() !== 0;
        break;
      case 6:
        requireWireType(wireType, 2);
        value.errorCode = reader.string();
        break;
      case 7:
        requireWireType(wireType, 2);
        value.errorMessage = reader.string();
        break;
      default:
        reader.skip(wireType);
    }
  });
  return value;
}
