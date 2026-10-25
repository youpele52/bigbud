import type {
  MonitorDemand,
  MonitorProcessQuery,
  MonitorProcessRoot,
} from "@bigbud/contracts/system-monitor/types";
import { MAX_FRAME_BYTES } from "./wire.constants";
export { MAX_FRAME_BYTES } from "./wire.constants";
export { decodeEvent } from "./wire.decode";

const encoder = new TextEncoder();

class Writer {
  bytes: number[] = [];
  private varint(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid unsigned integer");
    while (value >= 128) {
      this.bytes.push((value % 128) | 128);
      value = Math.floor(value / 128);
    }
    this.bytes.push(value);
  }
  uint(field: number, value: number): void {
    if (value) {
      this.varint(field * 8);
      this.varint(value);
    }
  }
  optionalUint(field: number, value: number | undefined): void {
    if (value === undefined) return;
    this.varint(field * 8);
    this.varint(value);
  }
  bigint(field: number, value: string): void {
    let remaining = BigInt(value);
    if (remaining < 0n || remaining > 0xffffffffffffffffn) throw new Error("invalid uint64");
    this.varint(field * 8);
    while (remaining >= 128n) {
      this.bytes.push(Number((remaining & 127n) | 128n));
      remaining >>= 7n;
    }
    this.bytes.push(Number(remaining));
  }
  bool(field: number, value: boolean): void {
    this.uint(field, value ? 1 : 0);
  }
  data(field: number, value: Uint8Array): void {
    this.varint(field * 8 + 2);
    this.varint(value.length);
    for (const byte of value) this.bytes.push(byte);
  }
  string(field: number, value: string): void {
    if (value) this.data(field, encoder.encode(value));
  }
  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}
function message(bytes: Uint8Array, field: number): Uint8Array {
  const writer = new Writer();
  writer.data(field, bytes);
  return writer.finish();
}
export function encodeCommand(
  command:
    | { type: "hello"; minor?: number }
    | { type: "subscribe"; requestId: number; demand: MonitorDemand; roots?: MonitorProcessRoot[] }
    | {
        type: "update";
        subscriptionId: number;
        demand: MonitorDemand;
        roots?: MonitorProcessRoot[];
      }
    | { type: "unsubscribe"; subscriptionId: number }
    | { type: "ack"; subscriptionId: number; epoch: number; sequence: number }
    | { type: "query"; requestId: number; query: MonitorProcessQuery }
    | { type: "retry"; requestId: number }
    | { type: "shutdown" },
): Uint8Array {
  const writer = new Writer();
  let field: number;
  switch (command.type) {
    case "hello":
      writer.uint(1, 1);
      writer.uint(2, command.minor ?? 3);
      field = 1;
      break;
    case "subscribe":
      writer.uint(1, command.requestId);
      writer.data(2, encodeDemand(command.demand, command.roots));
      field = 3;
      break;
    case "update":
      writer.uint(1, command.subscriptionId);
      writer.data(2, encodeDemand(command.demand, command.roots));
      field = 4;
      break;
    case "unsubscribe":
      writer.uint(1, command.subscriptionId);
      field = 5;
      break;
    case "ack":
      writer.uint(1, command.subscriptionId);
      writer.uint(2, command.epoch);
      writer.uint(3, command.sequence);
      field = 7;
      break;
    case "query": {
      const q = command.query;
      writer.uint(1, command.requestId);
      writer.string(2, q.name ?? "");
      writer.optionalUint(3, q.pid);
      writer.string(4, q.status ?? "");
      writer.string(5, q.sort);
      writer.bool(6, q.descending);
      writer.uint(7, q.limit);
      writer.uint(8, q.cursor?.generation ?? 0);
      if (q.cursor) writer.bigint(9, q.cursor.digest);
      writer.uint(10, q.cursor?.offset ?? 0);
      writer.string(11, q.search ?? "");
      field = 8;
      break;
    }
    case "retry":
      writer.uint(1, command.requestId);
      field = 10;
      break;
    case "shutdown":
      field = 12;
      break;
  }
  return message(writer.finish(), field);
}
function encodeDemand(value: MonitorDemand, roots: MonitorProcessRoot[] = []): Uint8Array {
  const writer = new Writer();
  writer.bool(1, value.processes);
  writer.bool(2, value.disks);
  writer.bool(3, value.sensors);
  writer.bool(4, value.appResources ?? false);
  if (roots.length > 128) throw new Error("too many app process roots");
  for (const root of roots) {
    const entry = new Writer();
    entry.uint(1, root.pid);
    entry.string(2, root.identity);
    entry.optionalUint(3, root.startTimeSeconds);
    entry.string(4, root.role);
    writer.data(5, entry.finish());
  }
  return writer.finish();
}
export function frameBytes(payload: Uint8Array): Uint8Array {
  if (!payload.length || payload.length > MAX_FRAME_BYTES)
    throw new Error("invalid monitor frame size");
  const frame = new Uint8Array(payload.length + 4);
  new DataView(frame.buffer).setUint32(0, payload.length);
  frame.set(payload, 4);
  return frame;
}
