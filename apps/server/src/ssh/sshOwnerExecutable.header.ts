import type { FileHandle } from "node:fs/promises";

import type { WorkspaceAgentTarget } from "../../../../scripts/lib/workspace-agent-target.ts";

async function readHeader(
  file: FileHandle,
  size: number,
  position: number,
): Promise<Buffer | null> {
  const header = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await file.read(header, offset, size - offset, position + offset);
    if (bytesRead === 0) return null;
    offset += bytesRead;
  }
  return header;
}

/** Check the declared native format and machine on the same descriptor that will be hashed. */
export async function matchesSshOwnerExecutableTarget(
  file: FileHandle,
  target: WorkspaceAgentTarget,
  sizeBytes: number,
): Promise<boolean> {
  const arm64 = target.arch === "arm64";
  if (target.platform === "darwin") {
    const mach = await readHeader(file, 32, 0);
    return (
      mach !== null &&
      mach.readUInt32LE(0) === 0xfeedfacf && // thin, little-endian, 64-bit Mach-O
      mach.readUInt32LE(4) === (arm64 ? 0x0100000c : 0x01000007) &&
      mach.readUInt32LE(12) === 2 // MH_EXECUTE
    );
  }
  if (target.platform === "linux") {
    const elf = await readHeader(file, 64, 0);
    if (!elf || elf.readUInt32BE(0) !== 0x7f454c46 || elf[4] !== 2 || elf[5] !== 1) return false;
    const type = elf.readUInt16LE(16);
    return (
      (type === 2 || type === 3) && // ET_EXEC or position-independent ET_DYN
      elf.readUInt16LE(18) === (arm64 ? 0xb7 : 0x3e)
    );
  }

  const dos = await readHeader(file, 64, 0);
  if (!dos || dos.readUInt16LE(0) !== 0x5a4d) return false;
  const peOffset = dos.readUInt32LE(0x3c);
  if (peOffset < dos.length || peOffset + 26 > sizeBytes) return false;
  const pe = await readHeader(file, 26, peOffset);
  if (!pe) return false;
  const optionalSize = pe.readUInt16LE(20);
  const flags = pe.readUInt16LE(22);
  return (
    pe.readUInt32LE(0) === 0x00004550 &&
    pe.readUInt16LE(4) === (arm64 ? 0xaa64 : 0x8664) &&
    (flags & 0x2002) === 0x0002 && // executable image, not a DLL
    optionalSize >= 2 &&
    peOffset + 24 + optionalSize <= sizeBytes &&
    pe.readUInt16LE(24) === 0x020b // PE32+
  );
}
