import {
  type RemoteAgentFrame,
  type RemoteAgentProcessEnvironment,
  type RemoteAgentPtyAttachRequest,
  type RemoteAgentPtyAttachResponse,
  type RemoteAgentPtyCloseRequest,
  type RemoteAgentPtyCloseResponse,
  type RemoteAgentPtyCreateRequest,
  type RemoteAgentPtyCreateResponse,
  type RemoteAgentPtyExited,
  type RemoteAgentPtyInput,
  type RemoteAgentPtyControlResponse,
  type RemoteAgentPtyOutput,
  type RemoteAgentPtyOutputAck,
  type RemoteAgentPtyResizeRequest,
  type RemoteAgentPtyResizeResponse,
  type RemoteAgentPtySignalRequest,
  type RemoteAgentPtySignalResponse,
} from "./remoteAgentProtocol.ts";
import { WireWriter } from "./remoteAgentProtocol.codec.wire.ts";

function encodeEnvironment(value: RemoteAgentProcessEnvironment): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.name);
  writer.fieldString(2, value.value);
  return writer.finish();
}

function encodeCreate(value: RemoteAgentPtyCreateRequest): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.ptyId);
  writer.fieldBytes(3, value.requestDigest);
  writer.fieldString(4, value.workspaceHandle);
  writer.fieldString(5, value.cwd);
  writer.fieldString(6, value.shell);
  for (const arg of value.args) writer.fieldString(7, arg);
  writer.fieldUint(8, value.cols);
  writer.fieldUint(9, value.rows);
  for (const environment of value.environment ?? []) {
    writer.fieldMessage(10, encodeEnvironment(environment));
  }
  return writer.finish();
}

function encodeCreateResponse(value: RemoteAgentPtyCreateResponse): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.ptyId);
  writer.fieldBool(3, value.accepted);
  writer.fieldUint(4, value.pid);
  writer.fieldString(5, value.errorCode);
  writer.fieldString(6, value.errorMessage);
  return writer.finish();
}

function encodeInput(value: RemoteAgentPtyInput): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.ptyId);
  writer.fieldUint(3, value.sequence);
  writer.fieldBytes(4, value.bytes);
  return writer.finish();
}

function encodeOutput(value: RemoteAgentPtyOutput): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.ptyId);
  writer.fieldUint(2, value.sequence);
  writer.fieldBytes(3, value.bytes);
  return writer.finish();
}

function encodeOutputAck(value: RemoteAgentPtyOutputAck): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.ptyId);
  writer.fieldUint(3, value.acknowledgedSequence);
  return writer.finish();
}

function encodeResize(value: RemoteAgentPtyResizeRequest): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.ptyId);
  writer.fieldUint(3, value.cols);
  writer.fieldUint(4, value.rows);
  return writer.finish();
}

function encodeResizeResponse(value: RemoteAgentPtyResizeResponse): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.ptyId);
  writer.fieldBool(3, value.accepted);
  writer.fieldString(4, value.errorCode);
  writer.fieldString(5, value.errorMessage);
  return writer.finish();
}

function encodeSignal(value: RemoteAgentPtySignalRequest): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.ptyId);
  writer.fieldString(3, value.signal);
  return writer.finish();
}

function encodeSignalResponse(value: RemoteAgentPtySignalResponse): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.ptyId);
  writer.fieldBool(3, value.accepted);
  writer.fieldString(4, value.errorCode);
  writer.fieldString(5, value.errorMessage);
  return writer.finish();
}

function encodeAttach(value: RemoteAgentPtyAttachRequest): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.ptyId);
  writer.fieldUint(3, value.afterSequence);
  return writer.finish();
}

function encodeAttachResponse(value: RemoteAgentPtyAttachResponse): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.ptyId);
  writer.fieldString(3, value.state);
  writer.fieldUint(4, value.pid);
  writer.fieldUint(5, value.nextSequence);
  writer.fieldUint(6, value.firstRetainedSequence);
  writer.fieldBool(7, value.replayGap);
  return writer.finish();
}

function encodeClose(value: RemoteAgentPtyCloseRequest): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.ptyId);
  writer.fieldBool(3, value.terminate);
  return writer.finish();
}

function encodeCloseResponse(value: RemoteAgentPtyCloseResponse): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.ptyId);
  writer.fieldBool(3, value.accepted);
  writer.fieldString(4, value.errorCode);
  writer.fieldString(5, value.errorMessage);
  return writer.finish();
}

function encodeExited(value: RemoteAgentPtyExited): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.ptyId);
  writer.fieldUint(2, value.exitCode < 0 ? value.exitCode + 0x1_0000_0000 : value.exitCode);
  writer.fieldBool(3, value.hasExitCode);
  writer.fieldUint(4, value.signal < 0 ? value.signal + 0x1_0000_0000 : value.signal);
  writer.fieldBool(5, value.hasSignal);
  return writer.finish();
}

function encodeControlResponse(value: RemoteAgentPtyControlResponse): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.requestId);
  writer.fieldString(2, value.ptyId);
  writer.fieldBool(3, value.accepted);
  writer.fieldString(4, value.errorCode);
  writer.fieldString(5, value.errorMessage);
  return writer.finish();
}

export function encodePtyFrame(
  frame: RemoteAgentFrame,
): { readonly field: number; readonly value: Uint8Array } | undefined {
  switch (frame.type) {
    case "ptyCreateRequest":
      return { field: 42, value: encodeCreate(frame.value) };
    case "ptyCreateResponse":
      return { field: 43, value: encodeCreateResponse(frame.value) };
    case "ptyInput":
      return { field: 44, value: encodeInput(frame.value) };
    case "ptyOutput":
      return { field: 45, value: encodeOutput(frame.value) };
    case "ptyOutputAck":
      return { field: 46, value: encodeOutputAck(frame.value) };
    case "ptyResizeRequest":
      return { field: 47, value: encodeResize(frame.value) };
    case "ptyResizeResponse":
      return { field: 48, value: encodeResizeResponse(frame.value) };
    case "ptySignalRequest":
      return { field: 49, value: encodeSignal(frame.value) };
    case "ptySignalResponse":
      return { field: 50, value: encodeSignalResponse(frame.value) };
    case "ptyAttachRequest":
      return { field: 51, value: encodeAttach(frame.value) };
    case "ptyAttachResponse":
      return { field: 52, value: encodeAttachResponse(frame.value) };
    case "ptyCloseRequest":
      return { field: 53, value: encodeClose(frame.value) };
    case "ptyCloseResponse":
      return { field: 54, value: encodeCloseResponse(frame.value) };
    case "ptyExited":
      return { field: 55, value: encodeExited(frame.value) };
    case "ptyInputResponse":
      return { field: 56, value: encodeControlResponse(frame.value) };
    case "ptyOutputAckResponse":
      return { field: 57, value: encodeControlResponse(frame.value) };
    default:
      return undefined;
  }
}
