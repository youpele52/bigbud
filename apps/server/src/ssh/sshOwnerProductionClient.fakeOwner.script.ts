/**
 * Test support: the disposable owner script body. Kept separate so the fixture
 * writer stays focused and every authored file respects the length limit.
 *
 * @module sshOwnerProductionClient.fakeOwner.script
 */

import { PROXY_HANDLER_SCRIPT } from "./sshOwnerProductionClient.fakeOwner.proxy.ts";

export const SCRIPT = String.raw`#!__EXEC__
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
const reconciliationId = Buffer.alloc(32, 3);
const helloAccepted = (major, reconciliation) => {
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
  if (reconciliation) {
    const failed =
      config.mode === "reconcile-retirement"
        ? 31
        : config.mode === "reconcile-pane"
          ? 36
          : 0;
    const echoed =
      config.mode === "reconcile-stale" ? Buffer.alloc(32, 4) : reconciliation.id;
    const partial = config.mode === "reconcile-partial";
    parts.push(uintField(8, failed === 0 ? 1 : 0));
    parts.push(bytesField(9, echoed));
    parts.push(bytesField(10, reconciliation.digest));
    parts.push(uintField(11, partial ? 0 : reconciliation.retirements));
    parts.push(uintField(12, partial ? 0 : reconciliation.panes));
    if (failed !== 0) parts.push(uintField(13, failed));
  }
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
const refuseIfConfigured = (target) => {
  if (config.rejectTarget === undefined || target !== config.rejectTarget) return 0;
  if (config.mode === "wrong-target") return 35;
  if (config.mode === "policy-refusal") return 5;
  return 0;
};
// One live terminal lease per target. Production owners keep the exact target
// and generation on the lease; the fake mirrors that identity so a client test
// can prove one target's close never reaches another's terminal.
const terminalLeases = new Map();
const terminalLease = (target) => {
  if (!terminalLeases.has(target)) {
    const lease = Buffer.alloc(32, 0);
    lease.writeUInt8(0x40 + terminalLeases.size, 0);
    lease.write(target.slice(0, 24), 1, "utf8");
    terminalLeases.set(target, lease);
  }
  return terminalLeases.get(target);
};
const proofTerminal = (lease, live) =>
  Buffer.concat([
    bytesField(1, lease),
    uintField(2, 4242),
    uintField(3, live ? 1 : 0),
    bytesField(4, live ? Buffer.from("ready\n") : Buffer.alloc(0)),
  ]);
const handleTerminal = (requestId, target, operation) => {
  const inner = parseFields(operation.value);
  const requested = field(inner, 1) ? field(inner, 1).value : Buffer.alloc(0);
  const known = terminalLeases.get(target);
  switch (operation.field) {
    case 28: // prepare_terminal
      return reply(requestId, target, 23, bytesField(1, terminalLease(target)));
    case 32: // cancel_terminal_reservation
      terminalLeases.delete(target);
      return reply(
        requestId,
        target,
        23,
        Buffer.concat([bytesField(1, requested), uintField(2, 1)]),
      );
    case 15: // open_terminal
      if (!known || (requested.length !== 0 && !requested.equals(known))) {
        return reply(requestId, target, 10, uintField(1, 2));
      }
      return reply(requestId, target, 14, proofTerminal(known, true));
    case 16: // terminal_status
    case 26: // terminal_input
    case 27: // terminal_resize
      if (!known || !requested.equals(known)) {
        return reply(requestId, target, 10, uintField(1, 2));
      }
      return reply(requestId, target, 14, proofTerminal(known, true));
    case 17: // close_terminal
      if (!known || !requested.equals(known)) {
        return reply(requestId, target, 10, uintField(1, 2));
      }
      terminalLeases.delete(target);
      return reply(requestId, target, 14, proofTerminal(known, false));
    case 33: // terminal_replay
      if (!known || !requested.equals(known)) {
        return reply(requestId, target, 10, uintField(1, 2));
      }
      return reply(
        requestId,
        target,
        25,
        Buffer.concat([
          bytesField(1, known),
          uintField(2, 1),
          uintField(3, 2),
          bytesField(4, Buffer.concat([uintField(1, 1), bytesField(2, Buffer.from("ready\n"))])),
          Buffer.alloc(0),
        ]),
      );
    default:
      return reply(requestId, target, 10, uintField(1, 2));
  }
};
${PROXY_HANDLER_SCRIPT}
const handleOperation = (requestId, target, operation) => {
  if (!operation) return reply(requestId, target, 10, uintField(1, 2));
  if (operation.field === 10) return reply(requestId, target, 11, trustVerified());
  if (operation.field === 14) return reply(requestId, target, 13, bytesField(1, "/home/fixture"));
  if (operation.field === 29 || operation.field === 30 || operation.field === 31)
    return handleAgentProxy(requestId, target, operation);
  if (operation.field === 50 || operation.field === 51 || operation.field === 52)
    return handleOpencode(requestId, target, operation);
  return handleTerminal(requestId, target, operation);
};
const handleRequest = (request) => {
  const requestId = field(request, 1).value;
  const target = text(field(request, 4) && field(request, 4).value);
  activity("request " + target);
  const operation = request.find((entry) => entry.field >= 10);
  if (!hydrated.has(target)) {
    pending = { requestId, target, operation };
    return send(7, bytesField(1, Buffer.from(target)));
  }
  return handleOperation(requestId, target, operation);
};
const handleSnapshot = (snapshot) => {
  const target = text(field(snapshot, 1).value);
  hydrated.add(target);
  if (!pending || pending.target !== target) return;
  const { requestId, operation } = pending;
  pending = null;
  return handleOperation(requestId, target, operation);
};
let buffer = Buffer.alloc(0);
let stage = 0;
let reconciliationRound = null;
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
    // Production owner: reconcile the backend's durable retirement mirror and
    // retained pane bindings before it accepts the session.
    reconciliationRound = { id: reconciliationId };
    send(
      18,
      Buffer.concat([
        bytesField(1, reconciliationId),
        bytesField(2, epoch),
        bytesField(3, Buffer.alloc(0)),
      ]),
    );
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
  if (!reconciliationRound || reconciliationRound.acknowledged === true) {
    if (field(fields, 5)) return handleGrant(parseFields(field(fields, 5).value));
    if (field(fields, 3)) return handleRequest(parseFields(field(fields, 3).value));
    if (field(fields, 8)) return handleSnapshot(parseFields(field(fields, 8).value));
    if (field(fields, 10) || field(fields, 9)) return;
    return;
  }
  const snapshot = field(fields, 19);
  if (!snapshot) return;
  const parsed = parseFields(snapshot.value);
  const requested = field(parsed, 1) ? field(parsed, 1).value : Buffer.alloc(0);
  const digest = field(parsed, 2) ? field(parsed, 2).value : Buffer.alloc(0);
  const retirements = parsed.filter((entry) => entry.field === 3).length;
  const panes = parsed.filter((entry) => entry.field === 4).length;
  activity("reconcile retirements=" + retirements + " panes=" + panes);
  if (!requested.equals(reconciliationRound.id)) return;
  reconciliationRound = {
    id: reconciliationRound.id,
    digest,
    retirements,
    panes,
    acknowledged: true,
  };
  send(2, helloAccepted(config.mode === "version-mismatch" ? 2 : 1, reconciliationRound));
  if (config.mode === "die") setTimeout(() => process.exit(0), 150);
  if (config.mode !== "die") {
    globalThis.__ownerHolder = require("node:net").createServer().listen(0);
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
