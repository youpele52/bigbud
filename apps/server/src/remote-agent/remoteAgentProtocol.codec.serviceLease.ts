import type {
  RemoteAgentServiceLeaseBinding,
  RemoteAgentServiceLeaseEnvironment,
  RemoteAgentServiceLeaseFrame,
  RemoteAgentServiceLeaseResponse,
} from "./remoteAgentProtocol.serviceLease.ts";
import { decodeMessage, requireWireType, WireWriter } from "./remoteAgentProtocol.codec.wire.ts";
import {
  decodeLeaseBinding,
  decodeLeaseEnvironment,
  encodeLeaseBinding,
  encodeLeaseEnvironment,
  encodeLeaseController,
  decodeLeaseController,
} from "./remoteAgentProtocol.codec.serviceLease.binding.ts";

export function encodeServiceLeaseFrame(frame: RemoteAgentServiceLeaseFrame): {
  field: number;
  value: Uint8Array;
} {
  const writer = new WireWriter();
  const value = frame.value;
  writer.fieldString(1, value.requestId);
  if ("accepted" in value) {
    writer.fieldBool(2, value.accepted);
    writer.fieldString(3, value.state);
    writer.fieldString(4, value.errorCode);
    if (value.binding) writer.fieldMessage(5, encodeLeaseBinding(value.binding));
    writer.fieldUint(6, value.generation);
    writer.fieldUint(7, value.originalChildPid);
    for (const item of value.bootstrap) writer.fieldMessage(8, encodeLeaseEnvironment(item));
    if (value.originalController)
      writer.fieldMessage(9, encodeLeaseController(value.originalController));
    if (value.currentController)
      writer.fieldMessage(10, encodeLeaseController(value.currentController));
    if (value.previousController)
      writer.fieldMessage(11, encodeLeaseController(value.previousController));
  } else {
    if (value.binding) writer.fieldMessage(2, encodeLeaseBinding(value.binding));
    if ("executable" in value) {
      writer.fieldString(3, value.executable);
      for (const argument of value.args) writer.fieldRepeatedString(4, argument);
      for (const item of value.environment) writer.fieldMessage(5, encodeLeaseEnvironment(item));
      writer.fieldBytes(6, value.capability);
      writer.fieldBytes(7, value.guard);
      writer.fieldString(8, value.assetsGeneration);
      writer.fieldUint(9, value.assetsReceiptSize);
      writer.fieldBytes(10, value.assetsReceiptSha256);
      writer.fieldString(11, value.assetsArgument);
    } else {
      writer.fieldBytes(3, value.capability);
      if ("action" in value) {
        writer.fieldUint(4, value.generation);
        writer.fieldString(5, value.action);
      }
    }
  }
  const fields = {
    serviceLeaseStartRequest: 120,
    serviceLeaseStartResponse: 121,
    serviceLeaseStatusRequest: 122,
    serviceLeaseStatusResponse: 123,
    serviceLeaseResumeRequest: 124,
    serviceLeaseResumeResponse: 125,
    serviceLeaseControlRequest: 126,
    serviceLeaseControlResponse: 127,
  };
  return { field: fields[frame.type], value: writer.finish() };
}

function request(bytes: Uint8Array, start: boolean, control: boolean) {
  const value: {
    requestId: string;
    binding: RemoteAgentServiceLeaseBinding | undefined;
    capability: Uint8Array;
    executable: string;
    guard: Uint8Array;
    assetsGeneration: string;
    assetsReceiptSize: number;
    assetsReceiptSha256: Uint8Array;
    assetsArgument: string;
    args: string[];
    environment: RemoteAgentServiceLeaseEnvironment[];
    generation: number;
    action: string;
  } = {
    requestId: "",
    binding: undefined,
    capability: new Uint8Array(),
    executable: "",
    guard: new Uint8Array(),
    assetsGeneration: "",
    assetsReceiptSize: 0,
    assetsReceiptSha256: new Uint8Array(),
    assetsArgument: "",
    args: [],
    environment: [],
    generation: 0,
    action: "",
  };
  decodeMessage(bytes, (field, wire, reader) => {
    if (field === 1) {
      requireWireType(wire, 2);
      value.requestId = reader.string();
    } else if (field === 2) {
      requireWireType(wire, 2);
      value.binding = decodeLeaseBinding(reader.bytesValue());
    } else if (field === (start ? 6 : 3)) {
      requireWireType(wire, 2);
      value.capability = reader.bytesValue();
    } else if (start && field === 7) {
      requireWireType(wire, 2);
      value.guard = reader.bytesValue();
    } else if (start && field === 8) {
      requireWireType(wire, 2);
      value.assetsGeneration = reader.string();
    } else if (start && field === 9) {
      requireWireType(wire, 0);
      value.assetsReceiptSize = reader.uint();
    } else if (start && field === 10) {
      requireWireType(wire, 2);
      value.assetsReceiptSha256 = reader.bytesValue();
    } else if (start && field === 11) {
      requireWireType(wire, 2);
      value.assetsArgument = reader.string();
    } else if (start && field === 3) {
      requireWireType(wire, 2);
      value.executable = reader.string();
    } else if (start && field === 4) {
      requireWireType(wire, 2);
      value.args.push(reader.string());
    } else if (start && field === 5) {
      requireWireType(wire, 2);
      value.environment.push(decodeLeaseEnvironment(reader.bytesValue()));
    } else if (control && field === 4) {
      requireWireType(wire, 0);
      value.generation = reader.uint();
    } else if (control && field === 5) {
      requireWireType(wire, 2);
      value.action = reader.string();
    } else reader.skip(wire);
  });
  return value;
}
function response(bytes: Uint8Array): RemoteAgentServiceLeaseResponse {
  const value: {
    -readonly [K in keyof RemoteAgentServiceLeaseResponse]: RemoteAgentServiceLeaseResponse[K];
  } = {
    requestId: "",
    accepted: false,
    state: "",
    errorCode: "",
    binding: undefined,
    generation: 0,
    originalChildPid: 0,
    bootstrap: [],
    originalController: undefined,
    currentController: undefined,
    previousController: undefined,
  };
  const bootstrap: RemoteAgentServiceLeaseEnvironment[] = [];
  decodeMessage(bytes, (field, wire, reader) => {
    switch (field) {
      case 1:
        requireWireType(wire, 2);
        value.requestId = reader.string();
        break;
      case 2:
        requireWireType(wire, 0);
        value.accepted = reader.uint() !== 0;
        break;
      case 3:
        requireWireType(wire, 2);
        value.state = reader.string();
        break;
      case 4:
        requireWireType(wire, 2);
        value.errorCode = reader.string();
        break;
      case 5:
        requireWireType(wire, 2);
        value.binding = decodeLeaseBinding(reader.bytesValue());
        break;
      case 6:
        requireWireType(wire, 0);
        value.generation = reader.uint();
        break;
      case 7:
        requireWireType(wire, 0);
        value.originalChildPid = reader.uint();
        break;
      case 8:
        requireWireType(wire, 2);
        bootstrap.push(decodeLeaseEnvironment(reader.bytesValue()));
        break;
      case 9:
        requireWireType(wire, 2);
        value.originalController = decodeLeaseController(reader.bytesValue());
        break;
      case 10:
        requireWireType(wire, 2);
        value.currentController = decodeLeaseController(reader.bytesValue());
        break;
      case 11:
        requireWireType(wire, 2);
        value.previousController = decodeLeaseController(reader.bytesValue());
        break;
      default:
        reader.skip(wire);
    }
  });
  value.bootstrap = bootstrap;
  return value;
}
export function decodeServiceLeaseFrame(
  field: number,
  bytes: Uint8Array,
): RemoteAgentServiceLeaseFrame | undefined {
  if (field < 120 || field > 127) return undefined;
  if (field % 2 === 1) {
    const type =
      field === 121
        ? "serviceLeaseStartResponse"
        : field === 123
          ? "serviceLeaseStatusResponse"
          : field === 125
            ? "serviceLeaseResumeResponse"
            : "serviceLeaseControlResponse";
    return { type, value: response(bytes) };
  }
  const value = request(bytes, field === 120, field === 126);
  const query = {
    requestId: value.requestId,
    binding: value.binding,
    capability: value.capability,
  };
  if (field === 120)
    return {
      type: "serviceLeaseStartRequest",
      value: {
        ...query,
        executable: value.executable,
        guard: value.guard,
        assetsGeneration: value.assetsGeneration,
        assetsReceiptSize: value.assetsReceiptSize,
        assetsReceiptSha256: value.assetsReceiptSha256,
        assetsArgument: value.assetsArgument,
        args: value.args,
        environment: value.environment,
      },
    };
  if (field === 126)
    return {
      type: "serviceLeaseControlRequest",
      value: { ...query, generation: value.generation, action: value.action },
    };
  return {
    type: field === 122 ? "serviceLeaseStatusRequest" : "serviceLeaseResumeRequest",
    value: query,
  };
}
