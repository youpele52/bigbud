import type { MobileGatewayTarget } from "@bigbud/contracts/server/mobileOptionalArtifact";

/** Header sanity only, never execution or a substitute for native-platform release testing. */
export function assertGatewayHeader(bytes: Buffer, target: MobileGatewayTarget): void {
  const arm = target.startsWith("aarch64-");
  if (target.includes("-linux-")) {
    if (
      bytes.length < 64 ||
      bytes.subarray(0, 4).toString("hex") !== "7f454c46" ||
      bytes[4] !== 2 ||
      bytes[5] !== 1 ||
      bytes.readUInt16LE(18) !== (arm ? 183 : 62) ||
      ![2, 3].includes(bytes.readUInt16LE(16))
    ) {
      throw new Error("Gateway ELF header does not match the selected target.");
    }
  } else if (target.endsWith("-darwin")) {
    if (
      bytes.length < 32 ||
      bytes.readUInt32LE(0) !== 0xfeedfacf ||
      bytes.readUInt32LE(4) !== (arm ? 0x0100000c : 0x01000007) ||
      bytes.readUInt32LE(12) !== 2
    ) {
      throw new Error("Gateway Mach-O executable header does not match the selected target.");
    }
  } else {
    const pe = bytes.length >= 64 ? bytes.readUInt32LE(0x3c) : -1;
    if (
      bytes.length < 64 ||
      bytes.toString("ascii", 0, 2) !== "MZ" ||
      pe < 64 ||
      pe > bytes.length - 26 ||
      bytes.readUInt32LE(pe) !== 0x00004550 ||
      bytes.readUInt16LE(pe + 4) !== (arm ? 0xaa64 : 0x8664) ||
      !(bytes.readUInt16LE(pe + 22) & 0x0002) ||
      bytes.readUInt16LE(pe + 22) & 0x2000 ||
      bytes.readUInt16LE(pe + 24) !== 0x20b
    ) {
      throw new Error("Gateway PE executable header does not match the selected target.");
    }
  }
}
