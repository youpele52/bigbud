import { decodeMessage, requireWireType } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
type Fields = Map<number, (number | Uint8Array)[]>;
export function fields(bytes: Uint8Array, schema: Record<number, number>): Fields {
  const values: Fields = new Map();
  decodeMessage(bytes, (field, wire, reader) => {
    const expected = schema[field];
    if (expected === undefined) {
      reader.skip(wire);
      return;
    }
    requireWireType(wire, expected);
    const list = values.get(field) ?? [];
    list.push(wire === 0 ? reader.uint() : reader.bytesValue());
    values.set(field, list);
  });
  return values;
}
export function single(values: Fields, field: number): number | Uint8Array | undefined {
  const list = values.get(field);
  if (list && list.length !== 1) throw new Error("duplicate organisation field");
  return list?.[0];
}
export function uint(values: Fields, field: number): number {
  const value = single(values, field);
  if (value === undefined) return 0;
  if (typeof value !== "number") throw new Error("invalid organisation integer");
  return value;
}
export function optionalUint(values: Fields, field: number): number | undefined {
  return values.has(field) ? uint(values, field) : undefined;
}
export function bytes(values: Fields, field: number): Uint8Array {
  const value = single(values, field);
  if (value === undefined) return new Uint8Array();
  if (typeof value === "number") throw new Error("invalid organisation message");
  return value;
}
export function text(values: Fields, field: number): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes(values, field));
}
