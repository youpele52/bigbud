import {
  REMOTE_AGENT_DEFAULT_MAX_FRAME_BYTES,
  RemoteAgentProtocolDecodeError,
  type RemoteAgentFrame,
} from "./remoteAgentProtocol.ts";
import { decodeFramePayload } from "./remoteAgentProtocol.codec.decode.ts";
import { encodeFramePayload } from "./remoteAgentProtocol.codec.encode.ts";

export { decodeFramePayload, encodeFramePayload };

export function encodeDelimitedFrame(
  frame: RemoteAgentFrame,
  maximum = REMOTE_AGENT_DEFAULT_MAX_FRAME_BYTES,
): Uint8Array {
  const payload = encodeFramePayload(frame);
  if (payload.length > maximum || payload.length > 0xffffffff) {
    throw new RangeError(`remote-agent frame exceeds maximum ${maximum} bytes`);
  }
  const result = new Uint8Array(payload.length + 4);
  new DataView(result.buffer).setUint32(0, payload.length, false);
  result.set(payload, 4);
  return result;
}

export function decodeDelimitedFrame(
  encoded: Uint8Array,
  maximum = REMOTE_AGENT_DEFAULT_MAX_FRAME_BYTES,
): RemoteAgentFrame {
  if (encoded.length < 4) throw new RemoteAgentProtocolDecodeError("frame prefix is truncated");
  const length = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength).getUint32(
    0,
    false,
  );
  if (length > maximum)
    throw new RemoteAgentProtocolDecodeError("frame exceeds configured maximum");
  if (encoded.length !== length + 4)
    throw new RemoteAgentProtocolDecodeError("frame length does not match prefix");
  return decodeFramePayload(encoded.slice(4));
}
