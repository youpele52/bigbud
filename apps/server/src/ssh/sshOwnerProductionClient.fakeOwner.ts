import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Test support: a disposable owner binary that speaks just enough of the v1
 * frame protocol to exercise the production client's spawn handshake. It is
 * never imported by product code.
 *
 * @module sshOwnerProductionClient.fakeOwner
 */

export type FakeOwnerMode =
  | "success"
  | "version-mismatch"
  | "oversized"
  | "silent"
  | "die"
  /** Refuses every request with the typed target-mismatch code (35). */
  | "wrong-target"
  /** Refuses every request with unsupported policy (5) before any request frame. */
  | "policy-refusal"
  /** Simulates an older owner that pinned one target at startup. */
  | "single-target";

export interface FakeOwnerOptions {
  readonly mode: FakeOwnerMode;
  readonly observationFile: string;
  /** Per-target grant/request activity, to prove a refused target dials nothing. */
  readonly activityFile?: string;
  readonly aliasDescriptor?: Buffer;
  /** Target the refusal modes reject; every other target still succeeds. */
  readonly rejectTarget?: string;
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
const activity = (line) => {
  if (config.activityFile) fs.appendFileSync(config.activityFile, line + "\n");
};
process.on("uncaughtException", (error) => {
  activity("crash " + (error && error.stack ? error.stack : String(error)));
  process.exit(1);
});
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
const readVarint = (buffer, offset) => {
  let value = 0;
  let shift = 0;
  let index = offset;
  while (index < buffer.length) {
    const byte = buffer[index++];
    value |= (byte & 127) << shift;
    if ((byte & 128) === 0) return [value >>> 0, index];
    shift += 7;
  }
  throw new Error("truncated varint");
};
const parseFields = (buffer) => {
  const fields = [];
  let index = 0;
  while (index < buffer.length) {
    const [key, next] = readVarint(buffer, index);
    index = next;
    const field = key >>> 3;
    const wire = key & 7;
    if (wire === 0) {
      const [value, after] = readVarint(buffer, index);
      index = after;
      fields.push({ field, wire, value });
    } else if (wire === 2) {
      const [length, after] = readVarint(buffer, index);
      fields.push({ field, wire, value: buffer.subarray(after, after + length) });
      index = after + length;
    } else if (wire === 1) {
      index += 8;
    } else if (wire === 5) {
      index += 4;
    } else {
      throw new Error("unsupported wire type");
    }
  }
  return fields;
};
const text = (value) => (value === undefined ? "" : value.toString("utf8"));
const field = (fields, number) => fields.find((entry) => entry.field === number);
const argv = process.argv;
const production = argv[2] === "--production";
const profileHex = production ? String(argv[4]).split(":")[2] : argv[2];
const echoHex = config.echoBindingHex || profileHex;
const echoBinding = Buffer.from(echoHex, "hex");
const epoch = Buffer.alloc(32, 7);
const pinnedGeneration = Buffer.alloc(32, 9);
const helloAccepted = (major) => {
  const multiTarget = production && config.mode !== "single-target";
  const parts = [
    uintField(1, major),
    uintField(2, 0),
    bytesField(3, epoch),
    bytesField(4, multiTarget ? Buffer.alloc(0) : pinnedGeneration),
    bytesField(6, echoBinding),
    uintField(7, multiTarget ? 1 : 0),
  ];
  if (config.aliasDescriptor) parts.push(bytesField(5, Buffer.from(config.aliasDescriptor, "hex")));
  return Buffer.concat(parts);
};
// One generation per target; the owner rotates it only on a durable transition.
const generations = new Map();
const generationFor = (target) => {
  if (!generations.has(target)) {
    generations.set(target, Buffer.alloc(32, 0x11 + generations.size));
  }
  return generations.get(target);
};
const hydrated = new Set();
let pending = null;
const grantReply = (requestId, error) =>
  send(6, Buffer.concat([
    bytesField(1, requestId),
    error === 0 ? bytesField(2, Buffer.alloc(32, 0x5a)) : Buffer.alloc(0),
    error === 0 ? Buffer.alloc(0) : uintField(3, error),
  ]));
const trustVerified = () =>
  Buffer.concat([
    uintField(1, 1),
    bytesField(3, Buffer.from("ssh-ed25519")),
    bytesField(4, Buffer.from("SHA256:fixture")),
  ]);
const reply = (requestId, target, outcomeField, outcome) =>
  send(4, Buffer.concat([
    bytesField(1, requestId),
    bytesField(2, epoch),
    bytesField(3, generationFor(target)),
    bytesField(outcomeField, outcome),
  ]));
const refuseIfConfigured = (target) => {
  if (config.rejectTarget === undefined || target !== config.rejectTarget) return 0;
  if (config.mode === "wrong-target") return 35;
  if (config.mode === "policy-refusal") return 5;
  return 0;
};
const handleGrant = (request) => {
  const requestId = field(request, 1).value;
  const target = text(field(request, 4) && field(request, 4).value);
  const generation = field(request, 3) ? field(request, 3).value : Buffer.alloc(0);
  activity("grant " + target);
  const configured = refuseIfConfigured(target);
  if (configured !== 0) return grantReply(requestId, configured);
  if (generation.length !== 0 && !generation.equals(generationFor(target))) {
    return grantReply(requestId, 12);
  }
  return grantReply(requestId, 0);
};
const handleRequest = (request) => {
  const requestId = field(request, 1).value;
  const target = text(field(request, 4) && field(request, 4).value);
  activity("request " + target);
  const operation = request.find((entry) => entry.field >= 10);
  const isTrust = operation && operation.field === 10;
  const isList = operation && operation.field === 14;
  if (!hydrated.has(target)) {
    pending = { requestId, target, isTrust, isList };
    return send(7, bytesField(1, Buffer.from(target)));
  }
  if (!operation || !(isTrust || isList)) return reply(requestId, target, 10, uintField(1, 2));
  if (isTrust) return reply(requestId, target, 11, trustVerified());
  return reply(requestId, target, 13, bytesField(1, "/home/fixture"));
};
const handleSnapshot = (snapshot) => {
  const target = text(field(snapshot, 1).value);
  hydrated.add(target);
  if (!pending || pending.target !== target) return;
  const { requestId, isTrust, isList } = pending;
  pending = null;
  if (isTrust) reply(requestId, target, 11, trustVerified());
  else if (isList) reply(requestId, target, 13, bytesField(1, "/home/fixture"));
  else reply(requestId, target, 10, uintField(1, 2));
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
    if (!production) {
      const target = argv[3];
      send(7, bytesField(1, Buffer.from(target)));
      return;
    }
    send(2, helloAccepted(config.mode === "version-mismatch" ? 2 : 1));
    if (config.mode === "die") setTimeout(() => process.exit(0), 150);
    if (config.mode !== "die") {
      globalThis.__ownerHolder = require("node:net").createServer().listen(0);
    }
    return;
  }
  if (!production) {
    if (stage === 1) {
      stage = 2;
      send(2, helloAccepted(config.mode === "version-mismatch" ? 2 : 1));
      if (config.mode === "die") setTimeout(() => process.exit(0), 150);
      if (config.mode === "success") {
        globalThis.__ownerHolder = require("node:net").createServer().listen(0);
      }
    }
    return;
  }
  const fields = parseFields(payload);
  if (field(fields, 5)) return handleGrant(parseFields(field(fields, 5).value));
  if (field(fields, 3)) return handleRequest(parseFields(field(fields, 3).value));
  if (field(fields, 8)) return handleSnapshot(parseFields(field(fields, 8).value));
  if (field(fields, 10) || field(fields, 9)) return;
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
    ...(options.activityFile === undefined ? {} : { activityFile: options.activityFile }),
    ...(options.aliasDescriptor === undefined
      ? {}
      : { aliasDescriptor: options.aliasDescriptor.toString("hex") }),
    ...(options.rejectTarget === undefined ? {} : { rejectTarget: options.rejectTarget }),
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
