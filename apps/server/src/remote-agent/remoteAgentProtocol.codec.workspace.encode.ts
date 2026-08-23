import {
  type RemoteAgentContentMatch,
  type RemoteAgentContentSearchRequest,
  type RemoteAgentContentSearchResponse,
  type RemoteAgentDirectoryEntry,
  type RemoteAgentFilenameSearchRequest,
  type RemoteAgentFilenameSearchResponse,
  type RemoteAgentFrame,
  type RemoteAgentListDirectoryRequest,
  type RemoteAgentListDirectoryResponse,
  type RemoteAgentReadFileRequest,
  type RemoteAgentReadFileResponse,
  type RemoteAgentWriteFileRequest,
  type RemoteAgentWriteFileResponse,
  type RemoteAgentWorkspaceOpenRequest,
  type RemoteAgentWorkspaceOpenResponse,
} from "./remoteAgentProtocol.ts";
import { WireWriter } from "./remoteAgentProtocol.codec.wire.ts";

function encodeWorkspaceOpenRequest(value: RemoteAgentWorkspaceOpenRequest): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.workspaceHandle);
  writer.fieldString(3, value.root);
  return writer.finish();
}

function encodeWorkspaceOpenResponse(value: RemoteAgentWorkspaceOpenResponse): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.workspaceHandle);
  writer.fieldBool(3, value.accepted);
  writer.fieldString(4, value.errorCode);
  writer.fieldString(5, value.errorMessage);
  return writer.finish();
}

function encodeOperationRequest(request: {
  readonly requestId: string;
  readonly operationId: string;
  readonly requestDigest: Uint8Array;
  readonly workspaceHandle: string;
  readonly path: string;
}): WireWriter {
  const writer = new WireWriter();
  writer.fieldString(1, request.requestId);
  writer.fieldString(2, request.operationId);
  writer.fieldBytes(3, request.requestDigest);
  writer.fieldString(4, request.workspaceHandle);
  writer.fieldString(5, request.path);
  return writer;
}

function encodeReadFileRequest(value: RemoteAgentReadFileRequest): Uint8Array {
  const writer = encodeOperationRequest(value);
  writer.fieldUint(6, value.offset);
  writer.fieldUint(7, value.maxBytes);
  return writer.finish();
}

function encodeReadFileResponse(value: RemoteAgentReadFileResponse): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.operationId);
  writer.fieldBool(3, value.terminal);
  writer.fieldBytes(4, value.bytes);
  writer.fieldUint(5, value.totalBytes);
  writer.fieldBool(6, value.truncated);
  writer.fieldString(7, value.errorCode);
  writer.fieldString(8, value.errorMessage);
  return writer.finish();
}

function encodeListDirectoryRequest(value: RemoteAgentListDirectoryRequest): Uint8Array {
  return encodeOperationRequest(value).finish();
}

function encodeDirectoryEntry(value: RemoteAgentDirectoryEntry): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.path);
  writer.fieldBool(2, value.isDirectory);
  writer.fieldBool(3, value.isFile);
  writer.fieldUint(4, value.sizeBytes);
  writer.fieldUint(5, value.modifiedUnixMs ?? 0);
  return writer.finish();
}

function encodeListDirectoryResponse(value: RemoteAgentListDirectoryResponse): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.operationId);
  writer.fieldBool(3, value.terminal);
  for (const entry of value.entries) writer.fieldBytes(4, encodeDirectoryEntry(entry));
  writer.fieldString(5, value.errorCode);
  writer.fieldString(6, value.errorMessage);
  return writer.finish();
}

function encodeFilenameSearchRequest(value: RemoteAgentFilenameSearchRequest): Uint8Array {
  const writer = encodeOperationRequest(value);
  writer.fieldString(6, value.query);
  writer.fieldUint(7, value.maxResults);
  return writer.finish();
}

function encodeFilenameSearchResponse(value: RemoteAgentFilenameSearchResponse): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.operationId);
  writer.fieldBool(3, value.terminal);
  for (const entry of value.entries) writer.fieldBytes(4, encodeDirectoryEntry(entry));
  writer.fieldBool(5, value.truncated);
  writer.fieldString(6, value.errorCode);
  writer.fieldString(7, value.errorMessage);
  return writer.finish();
}

function encodeContentSearchRequest(value: RemoteAgentContentSearchRequest): Uint8Array {
  const writer = encodeOperationRequest(value);
  writer.fieldString(6, value.query);
  writer.fieldUint(7, value.maxResults);
  return writer.finish();
}

function encodeContentMatch(value: RemoteAgentContentMatch): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.path);
  writer.fieldUint(2, value.line);
  writer.fieldUint(3, value.column);
  writer.fieldString(4, value.excerpt);
  return writer.finish();
}

function encodeContentSearchResponse(value: RemoteAgentContentSearchResponse): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.operationId);
  writer.fieldBool(3, value.terminal);
  for (const match of value.matches) writer.fieldBytes(4, encodeContentMatch(match));
  writer.fieldBool(5, value.truncated);
  writer.fieldString(6, value.errorCode);
  writer.fieldString(7, value.errorMessage);
  return writer.finish();
}

function encodeWriteFileRequest(value: RemoteAgentWriteFileRequest): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.operationId);
  writer.fieldBytes(3, value.requestDigest);
  writer.fieldString(4, value.workspaceHandle);
  writer.fieldString(5, value.path);
  writer.fieldBytes(6, value.bytes);
  writer.fieldString(7, value.expectedSha256);
  return writer.finish();
}

function encodeWriteFileResponse(value: RemoteAgentWriteFileResponse): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.operationId);
  writer.fieldBool(3, value.terminal);
  writer.fieldUint(4, value.writtenBytes);
  writer.fieldString(5, value.errorCode);
  writer.fieldString(6, value.errorMessage);
  writer.fieldString(7, value.currentSha256);
  return writer.finish();
}

export function encodeWorkspaceFrame(
  frame: RemoteAgentFrame,
): { readonly field: number; readonly value: Uint8Array } | undefined {
  switch (frame.type) {
    case "workspaceOpenRequest":
      return { field: 8, value: encodeWorkspaceOpenRequest(frame.value) };
    case "workspaceOpenResponse":
      return { field: 9, value: encodeWorkspaceOpenResponse(frame.value) };
    case "readFileRequest":
      return { field: 10, value: encodeReadFileRequest(frame.value) };
    case "readFileResponse":
      return { field: 11, value: encodeReadFileResponse(frame.value) };
    case "listDirectoryRequest":
      return { field: 12, value: encodeListDirectoryRequest(frame.value) };
    case "listDirectoryResponse":
      return { field: 13, value: encodeListDirectoryResponse(frame.value) };
    case "filenameSearchRequest":
      return { field: 14, value: encodeFilenameSearchRequest(frame.value) };
    case "filenameSearchResponse":
      return { field: 15, value: encodeFilenameSearchResponse(frame.value) };
    case "contentSearchRequest":
      return { field: 16, value: encodeContentSearchRequest(frame.value) };
    case "contentSearchResponse":
      return { field: 17, value: encodeContentSearchResponse(frame.value) };
    case "writeFileRequest":
      return { field: 26, value: encodeWriteFileRequest(frame.value) };
    case "writeFileResponse":
      return { field: 27, value: encodeWriteFileResponse(frame.value) };
    default:
      return undefined;
  }
}
