import { createHash } from "node:crypto";

import { WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import type {
  DesktopSupervisorApplicationAck,
  DesktopSupervisorEvent,
  DesktopSupervisorEventBatch,
  DesktopSupervisorFrame,
  DesktopSupervisorLimits,
} from "./desktopSupervisorProtocol.ts";

function encodeLimits(value: DesktopSupervisorLimits): Uint8Array {
  const writer = new WireWriter();
  writer.fieldUint(1, value.maxFrameBytes);
  writer.fieldUint(2, value.maxConsumers);
  writer.fieldUint(3, value.maxQueueEvents);
  writer.fieldUint(4, value.maxQueueBytes);
  writer.fieldUint(5, value.maxInFlightEvents);
  writer.fieldUint(6, value.acknowledgementTimeoutMs);
  return writer.finish();
}

function encodeEvent(value: DesktopSupervisorEvent): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.eventId);
  writer.fieldUint(2, value.sequence);
  writer.fieldBytes(3, value.canonicalPayload);
  return writer.finish();
}

export function encodeEventBatch(value: DesktopSupervisorEventBatch): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.batchId);
  writer.fieldString(2, value.serverEpoch);
  writer.fieldUint(3, value.subscriptionGeneration);
  writer.fieldString(4, value.consumerId);
  writer.fieldUint(5, value.consumerGeneration);
  for (const event of value.events) writer.fieldMessage(6, encodeEvent(event));
  return writer.finish();
}

export function computeDesktopSupervisorBatchId(
  value: Omit<DesktopSupervisorEventBatch, "batchId">,
): string {
  const encoded = encodeEventBatch({ ...value, batchId: "" });
  return createHash("sha256").update(encoded).digest("hex");
}

function encodeApplicationAck(value: DesktopSupervisorApplicationAck): Uint8Array {
  const writer = new WireWriter();
  writer.fieldString(1, value.batchId);
  writer.fieldString(2, value.consumerId);
  writer.fieldUint(3, value.consumerGeneration);
  writer.fieldUint(4, value.receivedThroughSequence);
  writer.fieldUint(5, value.appliedThroughSequence);
  writer.fieldUint(6, value.applicationDurationMs);
  return writer.finish();
}

function encodeFrameValue(frame: DesktopSupervisorFrame): { field: number; bytes: Uint8Array } {
  const writer = new WireWriter();
  switch (frame.type) {
    case "clientHello":
      writer.fieldUint(1, frame.value.protocolMajor);
      writer.fieldUint(2, frame.value.protocolMinor);
      writer.fieldString(3, frame.value.clientInstanceId);
      writer.fieldMessage(4, encodeLimits(frame.value.requestedLimits));
      return { field: 1, bytes: writer.finish() };
    case "supervisorHello":
      writer.fieldUint(1, frame.value.protocolMajor);
      writer.fieldUint(2, frame.value.protocolMinor);
      writer.fieldString(3, frame.value.supervisorInstanceId);
      writer.fieldMessage(4, encodeLimits(frame.value.acceptedLimits));
      return { field: 2, bytes: writer.finish() };
    case "attachConsumer":
      writer.fieldString(1, frame.value.consumerId);
      writer.fieldUint(2, frame.value.consumerGeneration);
      writer.fieldString(3, frame.value.serverEpoch);
      writer.fieldUint(4, frame.value.appliedSequence);
      return { field: 3, bytes: writer.finish() };
    case "consumerAttached":
      writer.fieldString(1, frame.value.consumerId);
      writer.fieldUint(2, frame.value.consumerGeneration);
      writer.fieldUint(3, frame.value.acknowledgedSequence);
      return { field: 4, bytes: writer.finish() };
    case "detachConsumer":
      writer.fieldString(1, frame.value.consumerId);
      writer.fieldUint(2, frame.value.consumerGeneration);
      writer.fieldString(3, frame.value.reason);
      return { field: 5, bytes: writer.finish() };
    case "eventBatch":
      return { field: 6, bytes: encodeEventBatch(frame.value) };
    case "applicationAck":
      return { field: 7, bytes: encodeApplicationAck(frame.value) };
    case "applicationAckAccepted":
      writer.fieldString(1, frame.value.batchId);
      writer.fieldString(2, frame.value.consumerId);
      writer.fieldUint(3, frame.value.consumerGeneration);
      writer.fieldUint(4, frame.value.acknowledgedSequence);
      return { field: 13, bytes: writer.finish() };
    case "heartbeat":
      writer.fieldUint(1, frame.value.monotonicMillis);
      return { field: 8, bytes: writer.finish() };
    case "metricsSnapshot":
      return { field: 10, bytes: writer.finish() };
    case "shutdown":
      writer.fieldString(1, frame.value.reason);
      return { field: 11, bytes: writer.finish() };
    case "protocolError":
      writer.fieldString(1, frame.value.code);
      writer.fieldString(2, frame.value.message);
      return { field: 12, bytes: writer.finish() };
    case "recoveryRequired":
      writer.fieldString(1, frame.value.consumerId);
      writer.fieldUint(2, frame.value.consumerGeneration);
      writer.fieldUint(3, frame.value.kind);
      writer.fieldUint(4, frame.value.fromSequenceExclusive);
      writer.fieldString(5, frame.value.reasonCode);
      return { field: 9, bytes: writer.finish() };
  }
}

export function encodeDesktopSupervisorFrame(frame: DesktopSupervisorFrame): Uint8Array {
  const value = encodeFrameValue(frame);
  const writer = new WireWriter();
  writer.fieldMessage(value.field, value.bytes);
  return writer.finish();
}
