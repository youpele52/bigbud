import type {
  RemoteAgentWriteFileRequest,
  RemoteAgentWriteFileResponse,
} from "./remoteAgentProtocol.ts";
import { decodeMessage, requireWireType } from "./remoteAgentProtocol.codec.wire.ts";

export function decodeWriteFileRequest(bytes: Uint8Array): RemoteAgentWriteFileRequest {
  const value = {
    requestId: "",
    operationId: "",
    requestDigest: new Uint8Array() as Uint8Array<ArrayBufferLike>,
    workspaceHandle: "",
    path: "",
    bytes: new Uint8Array() as Uint8Array<ArrayBufferLike>,
    expectedSha256: "",
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
        requireWireType(wireType, 2);
        value.path = reader.string();
        break;
      case 6:
        requireWireType(wireType, 2);
        value.bytes = reader.bytesValue();
        break;
      case 7:
        requireWireType(wireType, 2);
        value.expectedSha256 = reader.string();
        break;
      default:
        reader.skip(wireType);
    }
  });
  return value;
}

export function decodeWriteFileResponse(bytes: Uint8Array): RemoteAgentWriteFileResponse {
  const value = {
    requestId: "",
    operationId: "",
    terminal: false,
    writtenBytes: 0,
    errorCode: "",
    errorMessage: "",
    currentSha256: "",
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
        requireWireType(wireType, 0);
        value.writtenBytes = reader.uint();
        break;
      case 5:
        requireWireType(wireType, 2);
        value.errorCode = reader.string();
        break;
      case 6:
        requireWireType(wireType, 2);
        value.errorMessage = reader.string();
        break;
      case 7:
        requireWireType(wireType, 2);
        value.currentSha256 = reader.string();
        break;
      default:
        reader.skip(wireType);
    }
  });
  return value;
}
