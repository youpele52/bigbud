// Synthetic protocol peer for real pipe/cancellation tests, never native admission.
import { decodeMessage, WireWriter } from "./remoteAgentProtocol.codec.wire.ts";
import {
  decodeServiceLeaseFrame,
  encodeServiceLeaseFrame,
} from "./remoteAgentProtocol.codec.serviceLease.ts";
let buffer = Buffer.alloc(0),
  count = 0;
function reply(frame) {
  const result = encodeServiceLeaseFrame(frame),
    writer = new WireWriter();
  writer.fieldBytes(result.field, result.value);
  const bytes = writer.finish(),
    prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(bytes.length);
  process.stdout.write(Buffer.concat([prefix, bytes]));
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const size = buffer.readUInt32BE(0);
    if (size > 1024 * 1024) process.exit(2);
    if (buffer.length < size + 4) return;
    const payload = buffer.subarray(4, size + 4);
    buffer = buffer.subarray(size + 4);
    decodeMessage(payload, (field, wire, reader) => {
      if (wire !== 2) {
        reader.skip(wire);
        return;
      }
      const frame = decodeServiceLeaseFrame(field, reader.bytesValue());
      if (!frame) return;
      count++;
      if (frame.type === "serviceLeaseStatusRequest" && frame.value.capability[0] === 9) return;
      const type = frame.type.replace("Request", "Response"),
        state =
          frame.type === "serviceLeaseControlRequest" && frame.value.action === "cancel-pending"
            ? "cancelled"
            : "fixture";
      reply({
        type,
        value: {
          requestId: frame.value.requestId,
          accepted: true,
          state,
          errorCode: "",
          binding: frame.value.binding,
          generation: 0,
          originalChildPid: count,
          bootstrap: [],
          originalController: undefined,
          currentController: undefined,
          previousController: undefined,
        },
      });
    });
  }
});
process.stdin.on("end", () => process.exit(0));
