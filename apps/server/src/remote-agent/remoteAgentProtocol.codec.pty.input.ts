import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import { decodeMessage, requireWireType, WireWriter } from "./remoteAgentProtocol.codec.wire.ts";

export function encodePtyInputReconcileFrame(
  frame: RemoteAgentFrame,
): { field: number; value: Uint8Array } | undefined {
  if (frame.type !== "ptyInputReconcileRequest" && frame.type !== "ptyInputReconcileResponse")
    return;
  const writer = new WireWriter();
  const value = frame.value;
  writer.fieldString(1, value.requestId);
  writer.fieldString(
    2,
    frame.type === "ptyInputReconcileRequest" ? frame.value.expectedEpoch : frame.value.agentEpoch,
  );
  writer.fieldString(3, value.ptyId);
  writer.fieldBytes(4, value.createDigest);
  writer.fieldUint(5, value.sequence);
  writer.fieldBytes(6, value.payloadDigest);
  writer.fieldUint(7, value.byteLength);
  if (frame.type === "ptyInputReconcileResponse") {
    writer.fieldString(8, frame.value.outcome);
    writer.fieldUint(9, frame.value.bytesWritten);
    writer.fieldBool(10, frame.value.writerUsable);
    writer.fieldBool(11, frame.value.accepted);
    writer.fieldString(12, frame.value.errorCode);
  }
  return { field: frame.type === "ptyInputReconcileRequest" ? 64 : 65, value: writer.finish() };
}

export function decodePtyInputReconcileFrame(
  field: number,
  bytes: Uint8Array,
): RemoteAgentFrame | undefined {
  if (field !== 64 && field !== 65) return;
  const value = {
    requestId: "",
    epoch: "",
    ptyId: "",
    createDigest: new Uint8Array(0) as Uint8Array,
    sequence: 0,
    payloadDigest: new Uint8Array(0) as Uint8Array,
    byteLength: 0,
    outcome: "",
    bytesWritten: 0,
    writerUsable: false,
    accepted: false,
    errorCode: "",
  };
  decodeMessage(bytes, (key, wire, reader) => {
    if ([1, 2, 3, 4, 6].includes(key) || (field === 65 && [8, 12].includes(key))) {
      requireWireType(wire, 2);
      switch (key) {
        case 1:
          value.requestId = reader.string();
          break;
        case 2:
          value.epoch = reader.string();
          break;
        case 3:
          value.ptyId = reader.string();
          break;
        case 4:
          value.createDigest = reader.bytesValue();
          break;
        case 6:
          value.payloadDigest = reader.bytesValue();
          break;
        case 8:
          value.outcome = reader.string();
          break;
        case 12:
          value.errorCode = reader.string();
          break;
      }
    } else if ([5, 7].includes(key) || (field === 65 && [9, 10, 11].includes(key))) {
      requireWireType(wire, 0);
      const number = reader.uint();
      switch (key) {
        case 5:
          value.sequence = number;
          break;
        case 7:
          value.byteLength = number;
          break;
        case 9:
          value.bytesWritten = number;
          break;
        case 10:
          value.writerUsable = number === 1;
          break;
        case 11:
          value.accepted = number === 1;
          break;
      }
    } else reader.skip(wire);
  });
  const { requestId, ptyId, createDigest, sequence, payloadDigest, byteLength } = value;
  const identity = { requestId, ptyId, createDigest, sequence, payloadDigest, byteLength };
  return field === 64
    ? { type: "ptyInputReconcileRequest", value: { ...identity, expectedEpoch: value.epoch } }
    : {
        type: "ptyInputReconcileResponse",
        value: {
          ...identity,
          agentEpoch: value.epoch,
          outcome: value.outcome,
          bytesWritten: value.bytesWritten,
          writerUsable: value.writerUsable,
          accepted: value.accepted,
          errorCode: value.errorCode,
        },
      };
}
