import { ORGANIZATION_MAX_FRAME_BYTES } from "./organizationProtocol.ts";

/** Incremental length-prefixed decoder. Validate the prefix before allocating its payload. */
export class OrganizationFrameReader {
  private readonly prefix = Buffer.alloc(4);
  private prefixSize = 0;
  private payload: Buffer | undefined;
  private payloadSize = 0;

  constructor(private readonly maximum = ORGANIZATION_MAX_FRAME_BYTES) {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > ORGANIZATION_MAX_FRAME_BYTES)
      throw new Error("invalid organisation frame bound");
  }

  push(chunk: Uint8Array, receive: (frame: Uint8Array) => void): void {
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (!this.payload) {
        const count = Math.min(4 - this.prefixSize, chunk.byteLength - offset);
        this.prefix.set(chunk.subarray(offset, offset + count), this.prefixSize);
        offset += count;
        this.prefixSize += count;
        if (this.prefixSize !== 4) continue;
        const length = this.prefix.readUInt32BE();
        if (length === 0 || length > this.maximum)
          throw new Error("invalid organisation frame length");
        this.payload = Buffer.allocUnsafe(length);
        this.payloadSize = 0;
      }
      const count = Math.min(this.payload.length - this.payloadSize, chunk.byteLength - offset);
      this.payload.set(chunk.subarray(offset, offset + count), this.payloadSize);
      this.payloadSize += count;
      offset += count;
      if (this.payloadSize === this.payload.length) {
        const complete = this.payload;
        this.payload = undefined;
        this.prefixSize = 0;
        this.payloadSize = 0;
        receive(complete);
      }
    }
  }

  end(): void {
    if (this.prefixSize !== 0 || this.payload !== undefined)
      throw new Error("truncated organisation frame");
  }
}

export function organizationDelimitedFrame(payload: Uint8Array): Uint8Array {
  if (payload.byteLength === 0 || payload.byteLength > ORGANIZATION_MAX_FRAME_BYTES)
    throw new Error("invalid organisation frame size");
  const frame = new Uint8Array(payload.byteLength + 4);
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
  frame.set(payload, 4);
  return frame;
}
