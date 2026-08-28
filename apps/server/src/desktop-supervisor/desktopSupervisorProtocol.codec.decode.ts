import {
  decodeMessage,
  requireWireType,
  type WireReader,
} from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import {
  DesktopSupervisorProtocolError,
  type DesktopSupervisorApplicationAck,
  type DesktopSupervisorEvent,
  type DesktopSupervisorEventBatch,
  type DesktopSupervisorFrame,
  type DesktopSupervisorLimits,
} from "./desktopSupervisorProtocol.ts";

function readString(wireType: number, reader: WireReader): string {
  requireWireType(wireType, 2);
  return reader.string();
}

function readUint(wireType: number, reader: WireReader): number {
  requireWireType(wireType, 0);
  return reader.uint();
}

function decodeLimits(bytes: Uint8Array): DesktopSupervisorLimits {
  const value = {
    maxFrameBytes: 0,
    maxConsumers: 0,
    maxQueueEvents: 0,
    maxQueueBytes: 0,
    maxInFlightEvents: 0,
    acknowledgementTimeoutMs: 0,
  };
  decodeMessage(bytes, (field, wireType, reader) => {
    const key = [
      "maxFrameBytes",
      "maxConsumers",
      "maxQueueEvents",
      "maxQueueBytes",
      "maxInFlightEvents",
      "acknowledgementTimeoutMs",
    ][field - 1] as keyof typeof value | undefined;
    if (key) value[key] = readUint(wireType, reader);
    else reader.skip(wireType);
  });
  return value;
}

function decodeEvent(bytes: Uint8Array): DesktopSupervisorEvent {
  const value = {
    eventId: "",
    sequence: 0,
    canonicalPayload: new Uint8Array() as Uint8Array<ArrayBufferLike>,
  };
  decodeMessage(bytes, (field, wireType, reader) => {
    if (field === 1) value.eventId = readString(wireType, reader);
    else if (field === 2) value.sequence = readUint(wireType, reader);
    else if (field === 3) {
      requireWireType(wireType, 2);
      value.canonicalPayload = reader.bytesValue();
    } else reader.skip(wireType);
  });
  return value;
}

function decodeEventBatch(bytes: Uint8Array): DesktopSupervisorEventBatch {
  const value = {
    batchId: "",
    serverEpoch: "",
    subscriptionGeneration: 0,
    consumerId: "",
    consumerGeneration: 0,
    events: [] as DesktopSupervisorEvent[],
  };
  decodeMessage(bytes, (field, wireType, reader) => {
    if (field === 1) value.batchId = readString(wireType, reader);
    else if (field === 2) value.serverEpoch = readString(wireType, reader);
    else if (field === 3) value.subscriptionGeneration = readUint(wireType, reader);
    else if (field === 4) value.consumerId = readString(wireType, reader);
    else if (field === 5) value.consumerGeneration = readUint(wireType, reader);
    else if (field === 6) {
      requireWireType(wireType, 2);
      value.events.push(decodeEvent(reader.bytesValue()));
    } else reader.skip(wireType);
  });
  return value;
}

function decodeApplicationAck(bytes: Uint8Array): DesktopSupervisorApplicationAck {
  const value = {
    batchId: "",
    consumerId: "",
    consumerGeneration: 0,
    receivedThroughSequence: 0,
    appliedThroughSequence: 0,
    applicationDurationMs: 0,
  };
  decodeMessage(bytes, (field, wireType, reader) => {
    if (field === 1) value.batchId = readString(wireType, reader);
    else if (field === 2) value.consumerId = readString(wireType, reader);
    else if (field === 3) value.consumerGeneration = readUint(wireType, reader);
    else if (field === 4) value.receivedThroughSequence = readUint(wireType, reader);
    else if (field === 5) value.appliedThroughSequence = readUint(wireType, reader);
    else if (field === 6) value.applicationDurationMs = readUint(wireType, reader);
    else reader.skip(wireType);
  });
  return value;
}

function decodeHello(bytes: Uint8Array, supervisor: boolean): DesktopSupervisorFrame {
  const value = {
    protocolMajor: 0,
    protocolMinor: 0,
    instanceId: "",
    limits: decodeLimits(new Uint8Array()),
  };
  decodeMessage(bytes, (field, wireType, reader) => {
    if (field === 1) value.protocolMajor = readUint(wireType, reader);
    else if (field === 2) value.protocolMinor = readUint(wireType, reader);
    else if (field === 3) value.instanceId = readString(wireType, reader);
    else if (field === 4) {
      requireWireType(wireType, 2);
      value.limits = decodeLimits(reader.bytesValue());
    } else reader.skip(wireType);
  });
  return supervisor
    ? {
        type: "supervisorHello",
        value: {
          protocolMajor: value.protocolMajor,
          protocolMinor: value.protocolMinor,
          supervisorInstanceId: value.instanceId,
          acceptedLimits: value.limits,
        },
      }
    : {
        type: "clientHello",
        value: {
          protocolMajor: value.protocolMajor,
          protocolMinor: value.protocolMinor,
          clientInstanceId: value.instanceId,
          requestedLimits: value.limits,
        },
      };
}

function decodeAttach(bytes: Uint8Array, attached: boolean): DesktopSupervisorFrame {
  const value = { consumerId: "", consumerGeneration: 0, text: "", sequence: 0 };
  decodeMessage(bytes, (field, wireType, reader) => {
    if (field === 1) value.consumerId = readString(wireType, reader);
    else if (field === 2) value.consumerGeneration = readUint(wireType, reader);
    else if (field === 3 && attached) value.sequence = readUint(wireType, reader);
    else if (field === 3) value.text = readString(wireType, reader);
    else if (field === 4) value.sequence = readUint(wireType, reader);
    else reader.skip(wireType);
  });
  return attached
    ? {
        type: "consumerAttached",
        value: {
          consumerId: value.consumerId,
          consumerGeneration: value.consumerGeneration,
          acknowledgedSequence: value.sequence,
        },
      }
    : {
        type: "attachConsumer",
        value: {
          consumerId: value.consumerId,
          consumerGeneration: value.consumerGeneration,
          serverEpoch: value.text,
          appliedSequence: value.sequence,
        },
      };
}

function decodeSimpleFrame(field: number, bytes: Uint8Array): DesktopSupervisorFrame {
  if (field === 1 || field === 2) return decodeHello(bytes, field === 2);
  if (field === 3 || field === 4) return decodeAttach(bytes, field === 4);
  if (field === 6) return { type: "eventBatch", value: decodeEventBatch(bytes) };
  if (field === 7) return { type: "applicationAck", value: decodeApplicationAck(bytes) };
  if (field === 10) return { type: "metricsSnapshot" };
  const value = { first: "", second: "", generation: 0, sequence: 0, kind: 0 };
  decodeMessage(bytes, (nested, wireType, reader) => {
    if (nested === 1 && (field === 8 || field === 9)) {
      if (field === 8) value.sequence = readUint(wireType, reader);
      else value.first = readString(wireType, reader);
    } else if (nested === 1) value.first = readString(wireType, reader);
    else if (nested === 2 && field === 9) value.generation = readUint(wireType, reader);
    else if (nested === 2) value.second = readString(wireType, reader);
    else if (nested === 3 && field === 13) value.generation = readUint(wireType, reader);
    else if (nested === 3) value.kind = readUint(wireType, reader);
    else if (nested === 4) value.sequence = readUint(wireType, reader);
    else if (nested === 5) value.second = readString(wireType, reader);
    else reader.skip(wireType);
  });
  if (field === 13) {
    return {
      type: "applicationAckAccepted",
      value: {
        batchId: value.first,
        consumerId: value.second,
        consumerGeneration: value.generation,
        acknowledgedSequence: value.sequence,
      },
    };
  }
  if (field === 8) return { type: "heartbeat", value: { monotonicMillis: value.sequence } };
  if (field === 9) {
    return {
      type: "recoveryRequired",
      value: {
        consumerId: value.first,
        consumerGeneration: value.generation,
        kind: value.kind,
        fromSequenceExclusive: value.sequence,
        reasonCode: value.second,
      },
    };
  }
  if (field === 11) return { type: "shutdown", value: { reason: value.first } };
  if (field === 12) {
    return { type: "protocolError", value: { code: value.first, message: value.second } };
  }
  throw new DesktopSupervisorProtocolError(`unsupported desktop supervisor frame field ${field}`);
}

export function decodeDesktopSupervisorFrame(bytes: Uint8Array): DesktopSupervisorFrame {
  let frame: DesktopSupervisorFrame | undefined;
  decodeMessage(bytes, (field, wireType, reader) => {
    requireWireType(wireType, 2);
    if (frame) throw new DesktopSupervisorProtocolError("protobuf frame has multiple payloads");
    frame = decodeSimpleFrame(field, reader.bytesValue());
  });
  if (!frame) throw new DesktopSupervisorProtocolError("protobuf frame has no payload");
  return frame;
}
