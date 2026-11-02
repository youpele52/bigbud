import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { resolveCopilotRuntimeRelease, type CopilotRuntimeRelease } from "./Runtime.release.ts";
import type { CopilotRuntimeFetch } from "./Runtime.download.ts";

export interface TarMember {
  readonly name: string;
  readonly bytes: Buffer;
  readonly type?: string;
}

export function runtimeTar(members: readonly TarMember[]): Buffer {
  const blocks: Buffer[] = [];
  for (const member of members) {
    const header = Buffer.alloc(512);
    header.write(member.name, 0, 100);
    header.write("0000755\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${member.bytes.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.fill(32, 148, 156);
    header.write(member.type ?? "0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, member.bytes, Buffer.alloc((512 - (member.bytes.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

export function runtimeFixture(input: { version?: string; members?: readonly TarMember[] } = {}) {
  const members = input.members ?? [
    { name: "package/copilot", bytes: Buffer.from("#!/bin/sh\necho test\n") },
    { name: "package/package.json", bytes: Buffer.from('{"name":"fixture"}') },
    { name: "package/LICENSE.md", bytes: Buffer.from("License retained") },
    { name: "package/README.md", bytes: Buffer.from("Readme retained") },
  ];
  const tar = runtimeTar(members);
  const bytes = gzipSync(tar);
  const release: CopilotRuntimeRelease = {
    ...resolveCopilotRuntimeRelease({ platform: "darwin", arch: "arm64", isMusl: false }),
    ...(input.version ? { version: input.version } : {}),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    archiveBytes: bytes.length,
    unpackedBytes: members.reduce((total, member) => total + member.bytes.length, 0),
  };
  return { members, tar, bytes, release };
}

export function archiveFetch(bytes: Uint8Array): CopilotRuntimeFetch {
  return async () => new Response(bytes);
}
