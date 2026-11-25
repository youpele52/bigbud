import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Test support: a disposable owner binary that speaks just enough of the v1
 * frame protocol to exercise the production client's spawn handshake. It is
 * never imported by product code.
 *
 * @module sshOwnerProductionClient.fakeOwner
 */

export type FakeOwnerMode = "success" | "version-mismatch" | "oversized" | "silent" | "die";

export interface FakeOwnerOptions {
  readonly mode: FakeOwnerMode;
  readonly observationFile: string;
  readonly aliasDescriptor?: Buffer;
  /** Simulates an owner that echoes a different startup profile binding. */
  readonly echoBindingHex?: string;
}

const SCRIPT = String.raw`#!__EXEC__
"use strict";
const fs = require("node:fs");
const config = __CONFIG__;
fs.writeFileSync(
  config.observationFile,
  JSON.stringify({ env: process.env, argv: process.argv, pid: process.pid }),
);
const varint = (value) => {
  const bytes = [];
  while (value > 127) {
    bytes.push((value & 127) | 128);
    value >>>= 7;
  }
  bytes.push(value);
  return Buffer.from(bytes);
};
const tag = (field, wire) => varint((field << 3) | wire);
const uintField = (field, value) => Buffer.concat([tag(field, 0), varint(value)]);
const bytesField = (field, value) => Buffer.concat([tag(field, 2), varint(value.length), value]);
const frame = (payload) => {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
};
const send = (field, payload) => fs.writeSync(1, frame(bytesField(field, payload)));
const argv = process.argv;
const production = argv[2] === "--production";
const profileHex = production ? String(argv[4]).split(":")[2] : argv[2];
const target = production ? argv[7] : argv[3];
const echoHex = config.echoBindingHex || profileHex;
const echoBinding = Buffer.from(echoHex, "hex");
const epoch = Buffer.alloc(32, 7);
const generation = Buffer.alloc(32, 9);
const helloAccepted = (major) => {
  const parts = [
    uintField(1, major),
    uintField(2, 0),
    bytesField(3, epoch),
    bytesField(4, generation),
    bytesField(6, echoBinding),
  ];
  if (config.aliasDescriptor) parts.push(bytesField(5, Buffer.from(config.aliasDescriptor, "hex")));
  return Buffer.concat(parts);
};
let buffer = Buffer.alloc(0);
let stage = 0;
const keepAlive = () => setInterval(() => {}, 1000);
const onFrame = (payload) => {
  if (stage === 0) {
    if (config.mode === "silent") return;
    if (config.mode === "oversized") {
      const header = Buffer.alloc(5);
      header.writeUInt32BE(8 * 1024 * 1024 + 1, 0);
      fs.writeSync(1, header);
      return;
    }
    stage = 1;
    send(7, bytesField(1, Buffer.from(target)));
    return;
  }
  if (stage === 1) {
    stage = 2;
    send(2, helloAccepted(config.mode === "version-mismatch" ? 2 : 1));
    if (config.mode === "die") setTimeout(() => process.exit(0), 150);
    if (config.mode === "success") {
      // Hold a real handle so ending inherited stdin does not tear the fixture
      // down; a real owner survives on its attachment listener.
      globalThis.__ownerHolder = require("node:net").createServer().listen(0);
    }
    return;
  }
};
const pump = () => {
  while (buffer.length >= 4) {
    const size = buffer.readUInt32BE(0);
    if (buffer.length < 4 + size) return;
    const payload = buffer.subarray(4, 4 + size);
    buffer = buffer.subarray(4 + size);
    onFrame(payload);
  }
};
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  pump();
});
process.stdin.on("end", () => {});
process.stdin.on("error", () => {});
process.stdin.resume();
keepAlive();
`;

export async function writeFakeSshOwnerBinary(
  directory: string,
  options: FakeOwnerOptions,
): Promise<string> {
  const path = join(directory, `fake-owner-${options.mode}`);
  const config = {
    mode: options.mode,
    observationFile: options.observationFile,
    ...(options.aliasDescriptor === undefined
      ? {}
      : { aliasDescriptor: options.aliasDescriptor.toString("hex") }),
    ...(options.echoBindingHex === undefined ? {} : { echoBindingHex: options.echoBindingHex }),
  };
  await writeFile(
    path,
    SCRIPT.replace("__EXEC__", process.execPath).replace("__CONFIG__", JSON.stringify(config)),
    { mode: 0o700 },
  );
  await chmod(path, 0o700);
  return path;
}

export interface FakeOwnerObservation {
  readonly env: Record<string, string>;
  readonly argv: ReadonlyArray<string>;
  readonly pid: number;
}

export const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
};
