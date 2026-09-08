import {
  DESKTOP_SUPERVISOR_MAX_FRAME_BYTES,
  DesktopSupervisorProtocolError,
  type DesktopSupervisorFrame,
} from "./desktopSupervisorProtocol.ts";
import { decodeDesktopSupervisorFrame } from "./desktopSupervisorProtocol.codec.decode.ts";
import { encodeDesktopSupervisorFrame } from "./desktopSupervisorProtocol.codec.encode.ts";

export { computeDesktopSupervisorBatchId } from "./desktopSupervisorProtocol.codec.encode.ts";

export function encodeDesktopSupervisorDelimitedFrame(
  frame: DesktopSupervisorFrame,
  maxFrameBytes = DESKTOP_SUPERVISOR_MAX_FRAME_BYTES,
): Uint8Array {
  const payload = encodeDesktopSupervisorFrame(frame);
  if (payload.length === 0 || payload.length > maxFrameBytes) {
    throw new DesktopSupervisorProtocolError("frame exceeds configured maximum");
  }
  const encoded = new Uint8Array(payload.length + 4);
  new DataView(encoded.buffer).setUint32(0, payload.length, false);
  encoded.set(payload, 4);
  return encoded;
}

export function decodeDesktopSupervisorDelimitedFrame(
  encoded: Uint8Array,
  maxFrameBytes = DESKTOP_SUPERVISOR_MAX_FRAME_BYTES,
): DesktopSupervisorFrame {
  if (encoded.length < 4) throw new DesktopSupervisorProtocolError("frame prefix is truncated");
  const length = new DataView(encoded.buffer, encoded.byteOffset, 4).getUint32(0, false);
  if (length === 0 || length > maxFrameBytes) {
    throw new DesktopSupervisorProtocolError("frame length is invalid");
  }
  if (encoded.length !== length + 4) {
    throw new DesktopSupervisorProtocolError("frame length does not match prefix");
  }
  return decodeDesktopSupervisorFrame(encoded.slice(4));
}
