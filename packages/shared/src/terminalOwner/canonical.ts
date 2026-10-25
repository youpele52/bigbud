import { Schema } from "effect";
import { identityLayouts, identitySchemas } from "./canonical.identity";
import { authLayouts, authSchemas } from "./canonical.auth";
import { validateRecordSemantics } from "./canonical.validation";
import { requireContract, TerminalOwnerContractError } from "./errors";
import { canonicalArrayValues } from "./canonical.array";

const layouts = { ...identityLayouts, ...authLayouts };
const schemas = { ...identitySchemas, ...authSchemas };
export type CanonicalRecord = keyof typeof layouts;
const encoder = new TextEncoder();
type Field = readonly [string, string];
type Chunk = { type: string; value: unknown; size: number };

function textSize(value: unknown): number {
  requireContract(typeof value === "string" && value.length <= 49152, "CANONICAL_INVALID");
  let bytes = 0;
  for (const char of value) {
    const point = char.codePointAt(0)!;
    requireContract(point < 0xd800 || point > 0xdfff, "CANONICAL_UTF8");
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Strict typed C only: no protobuf decoder, JSON MAC, normalization or coercion. */
export function encodeCanonical(name: CanonicalRecord, input: unknown): Uint8Array {
  const chunks: Chunk[] = [];
  let total = 0;
  function add(type: string, value: unknown, size: number) {
    total += size;
    requireContract(total <= 65536, "CANONICAL_LIMIT");
    chunks.push({ type, value, size });
  }
  function walk(type: string, value: unknown, depth: number): void {
    requireContract(depth <= 8, "CANONICAL_DEPTH");
    if (type.endsWith("[]")) {
      const values = canonicalArrayValues(value);
      add("U32", values.length, 4);
      for (const item of values) walk(type.slice(0, -2), item, depth + 1);
    } else if (type in layouts) {
      requireContract(
        value !== null && typeof value === "object" && !Array.isArray(value),
        "CANONICAL_INVALID",
      );
      const fields: readonly Field[] = layouts[type as CanonicalRecord];
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const allowed = new Set(fields.map(([key]) => key));
      requireContract(
        Object.keys(descriptors).every((key) => allowed.has(key)) &&
          Object.getOwnPropertySymbols(value).length === 0,
        "CANONICAL_FIELDS",
      );
      for (const [key, operand] of fields) {
        const descriptor = descriptors[key];
        requireContract(!descriptor || "value" in descriptor, "CANONICAL_ACCESSOR");
        if (operand.endsWith("?")) {
          add("E", descriptor ? 1 : 0, 1);
          if (descriptor) walk(operand.slice(0, -1), descriptor.value, depth + 1);
        } else {
          requireContract(descriptor, "CANONICAL_PRESENCE");
          walk(operand, descriptor.value, depth + 1);
        }
      }
    } else if (type === "S") add(type, value, 4 + textSize(value));
    else if (type === "ID" || type === "B") {
      requireContract(
        value instanceof Uint8Array &&
          !(value.buffer instanceof SharedArrayBuffer) &&
          value.length <= 49152 &&
          (type !== "ID" || value.length === 32),
        "CANONICAL_BYTES",
      );
      add(type, value, value.length + (type === "B" ? 4 : 0));
    } else if (type === "U64") {
      requireContract(
        typeof value === "string" &&
          /^(0|[1-9][0-9]{0,19})$/.test(value) &&
          BigInt(value) <= 18446744073709551615n,
        "CANONICAL_U64",
      );
      add(type, value, 8);
    } else {
      const width = type === "U32" ? 4 : type === "V" ? 2 : 1;
      requireContract(
        typeof value === "number" &&
          Number.isInteger(value) &&
          value >= 0 &&
          value < 2 ** (8 * width),
        "CANONICAL_NUMBER",
      );
      add(type, value, width);
    }
  }
  walk(name, input, 0);
  try {
    Schema.decodeUnknownSync(schemas[name])(input, { onExcessProperty: "error" });
    validateRecordSemantics(name, input);
  } catch (error) {
    if (error instanceof TerminalOwnerContractError) throw error;
    // Effect parse failures may echo values: never retain them as public causes.
    throw new TerminalOwnerContractError("CANONICAL_SCHEMA");
  }
  const result = new Uint8Array(total);
  const view = new DataView(result.buffer);
  let offset = 0;
  for (const { type, value, size } of chunks) {
    if (type === "ID") result.set(value as Uint8Array, offset);
    else if (type === "B" || type === "S") {
      view.setUint32(offset, size - 4);
      if (type === "B") result.set(value as Uint8Array, offset + 4);
      else encoder.encodeInto(value as string, result.subarray(offset + 4, offset + size));
    } else if (type === "U64") view.setBigUint64(offset, BigInt(value as string));
    else if (size === 4) view.setUint32(offset, value as number);
    else if (size === 2) view.setUint16(offset, value as number);
    else view.setUint8(offset, value as number);
    offset += size;
  }
  return result;
}

/** Literal S operand in the normative domain-separated equations. */
export function canonicalDomain(domain: string): Uint8Array {
  const size = textSize(domain);
  const bytes = new Uint8Array(4 + size);
  new DataView(bytes.buffer).setUint32(0, size);
  encoder.encodeInto(domain, bytes.subarray(4));
  return bytes;
}
