import {
  type RemoteAgentDirectoryEntry,
  type RemoteAgentFilenameSearchResponse,
  type RemoteAgentListDirectoryResponse,
} from "./remoteAgentProtocol.ts";
import { decodeMessage, requireWireType } from "./remoteAgentProtocol.codec.wire.ts";

type MutableDirectoryEntry = {
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  sizeBytes: number;
  modifiedUnixMs?: number;
};

function decodeDirectoryEntry(bytes: Uint8Array): RemoteAgentDirectoryEntry {
  const value: MutableDirectoryEntry = {
    path: "",
    isDirectory: false,
    isFile: false,
    sizeBytes: 0,
  };
  decodeMessage(bytes, (field, wireType, reader) => {
    switch (field) {
      case 1:
        requireWireType(wireType, 2);
        value.path = reader.string();
        break;
      case 2:
        requireWireType(wireType, 0);
        value.isDirectory = reader.uint() !== 0;
        break;
      case 3:
        requireWireType(wireType, 0);
        value.isFile = reader.uint() !== 0;
        break;
      case 4:
        requireWireType(wireType, 0);
        value.sizeBytes = reader.uint();
        break;
      case 5:
        requireWireType(wireType, 0);
        value.modifiedUnixMs = reader.uint();
        break;
      default:
        reader.skip(wireType);
    }
  });
  return value;
}

function decodeListDirectoryResponse(bytes: Uint8Array): RemoteAgentListDirectoryResponse {
  const value = {
    requestId: "",
    operationId: "",
    terminal: false,
    entries: [] as RemoteAgentDirectoryEntry[],
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
        value.entries.push(decodeDirectoryEntry(reader.bytesValue()));
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

function decodeFilenameSearchResponse(bytes: Uint8Array): RemoteAgentFilenameSearchResponse {
  const value = {
    requestId: "",
    operationId: "",
    terminal: false,
    entries: [] as RemoteAgentDirectoryEntry[],
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
        value.entries.push(decodeDirectoryEntry(reader.bytesValue()));
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

export { decodeDirectoryEntry, decodeListDirectoryResponse, decodeFilenameSearchResponse };
