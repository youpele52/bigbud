import { WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
export function optionalUint(writer: WireWriter, field: number, value: number | undefined): void {
  if (value === undefined) return;
  // Proto3 optional zero retains presence, including tags larger than one byte.
  if (value === 0) {
    let tag = field * 8;
    while (tag >= 128) {
      writer.bytes.push((tag % 128) | 128);
      tag = Math.floor(tag / 128);
    }
    writer.bytes.push(tag, 0);
  } else writer.fieldUint(field, value);
}
