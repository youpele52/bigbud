import {
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
import { WireWriter } from "./remoteAgentProtocol.codec.wire.ts";

function encodeProcessRequest(value: RemoteAgentProcessRequest): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.operationId);
  writer.fieldBytes(3, value.requestDigest);
  writer.fieldString(4, value.workspaceHandle);
  writer.fieldString(5, value.command);
  for (const arg of value.args) writer.fieldString(6, arg);
  writer.fieldUint(7, value.timeoutMs);
  writer.fieldUint(8, value.maxOutputBytes);
  for (const environment of value.environment ?? []) {
    writer.fieldMessage(9, encodeProcessEnvironment(environment));
  }
  if (value.stdin && value.stdin.length > 0) writer.fieldBytes(10, value.stdin);
  return writer.finish();
}

function encodeProcessEnvironment(value: RemoteAgentProcessEnvironment): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.name);
  writer.fieldString(2, value.value);
  return writer.finish();
}

function encodeProcessAccepted(value: RemoteAgentProcessAccepted): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.operationId);
  writer.fieldBool(3, value.accepted);
  writer.fieldBool(4, value.duplicate);
  writer.fieldString(5, value.errorCode);
  writer.fieldString(6, value.errorMessage);
  return writer.finish();
}

function encodeProcessOutput(value: RemoteAgentProcessOutput): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.operationId);
  writer.fieldUint(2, value.sequence);
  writer.fieldString(3, value.stream);
  writer.fieldBytes(4, value.bytes);
  return writer.finish();
}

function encodeProcessCompleted(value: RemoteAgentProcessCompleted): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.operationId);
  writer.fieldString(3, value.state);
  writer.fieldBool(4, value.hasExitCode);
  if (value.hasExitCode) {
    writer.fieldUint(5, value.exitCode < 0 ? value.exitCode + 0x1_0000_0000 : value.exitCode);
  }
  writer.fieldBool(6, value.outputTruncated);
  writer.fieldString(7, value.errorCode);
  writer.fieldString(8, value.errorMessage);
  return writer.finish();
}

function encodeProcessAttachRequest(value: RemoteAgentProcessAttachRequest): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.operationId);
  writer.fieldUint(3, value.afterSequence);
  return writer.finish();
}

function encodeProcessOutputAck(value: RemoteAgentProcessOutputAck): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.operationId);
  writer.fieldUint(3, value.acknowledgedSequence);
  return writer.finish();
}

function encodeProcessAckResponse(value: RemoteAgentProcessAckResponse): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.operationId);
  writer.fieldBool(3, value.accepted);
  writer.fieldString(4, value.errorCode);
  writer.fieldString(5, value.errorMessage);
  return writer.finish();
}

function encodeProcessAttachResponse(value: RemoteAgentProcessAttachResponse): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.operationId);
  writer.fieldString(3, value.state);
  writer.fieldUint(4, value.nextSequence);
  writer.fieldUint(5, value.firstRetainedSequence);
  return writer.finish();
}

export function encodeProcessFrame(
  frame: RemoteAgentFrame,
): { readonly field: number; readonly value: Uint8Array } | undefined {
  switch (frame.type) {
    case "processRequest":
      return { field: 18, value: encodeProcessRequest(frame.value) };
    case "processAccepted":
      return { field: 19, value: encodeProcessAccepted(frame.value) };
    case "processOutput":
      return { field: 20, value: encodeProcessOutput(frame.value) };
    case "processCompleted":
      return { field: 21, value: encodeProcessCompleted(frame.value) };
    case "processAttachRequest":
      return { field: 22, value: encodeProcessAttachRequest(frame.value) };
    case "processOutputAck":
      return { field: 23, value: encodeProcessOutputAck(frame.value) };
    case "processAckResponse":
      return { field: 24, value: encodeProcessAckResponse(frame.value) };
    case "processAttachResponse":
      return { field: 25, value: encodeProcessAttachResponse(frame.value) };
    default:
      return undefined;
  }
}
