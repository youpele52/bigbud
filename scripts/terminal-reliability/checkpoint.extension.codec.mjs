import {
  PageWriter,
  PageReader,
  TypedSlice,
  MAX_CHECKPOINT_BYTES,
} from "./checkpoint.extension.pages.mjs";
export { MAX_CHECKPOINT_BYTES } from "./checkpoint.extension.pages.mjs";
const kinds = [
  "number",
  "bool",
  "string",
  "literal",
  "optional",
  "nullable",
  "list",
  "tuple",
  "record",
  "map",
  "typed",
  "enum",
];
const types = ["u32", "i32", "u16", "cells"];
const unsafeKey = (key) => ["__proto__", "constructor", "prototype"].includes(key);
function checked(condition, detail) {
  if (!condition) throw new Error(`invalid checkpoint ${detail}`);
}

function write(writer, schema, value) {
  writer.byte(kinds.indexOf(schema.kind));
  switch (schema.kind) {
    case "number":
      checked(
        Number.isFinite(value) &&
          value >= schema.min &&
          value <= schema.max &&
          (!schema.integer || Number.isSafeInteger(value)),
        "number",
      );
      writer.number(value);
      break;
    case "bool":
      checked(typeof value === "boolean", "boolean");
      writer.byte(Number(value));
      break;
    case "string":
      checked(typeof value === "string" && value.length <= schema.max, "string");
      writer.string(value);
      break;
    case "literal":
      checked(value === schema.value, "literal");
      break;
    case "optional":
      writer.byte(value === undefined ? 0 : 1);
      if (value !== undefined) write(writer, schema.item, value);
      break;
    case "nullable":
      writer.byte(value === null ? 0 : 1);
      if (value !== null) write(writer, schema.item, value);
      break;
    case "enum": {
      const index = schema.values.indexOf(value);
      checked(index >= 0, "enum");
      writer.byte(index);
      break;
    }
    case "list":
      checked(
        Array.isArray(value) &&
          value.length <= schema.max &&
          (schema.exact === undefined || value.length === schema.exact),
        "list count",
      );
      writer.u32(value.length);
      for (const item of value) write(writer, schema.item, item);
      break;
    case "tuple":
      checked(Array.isArray(value) && value.length === schema.items.length, "tuple count");
      writer.u32(value.length);
      schema.items.forEach((item, index) => write(writer, item, value[index]));
      break;
    case "record": {
      checked(
        value &&
          typeof value === "object" &&
          Object.keys(value).length === Object.keys(schema.fields).length &&
          Object.keys(value).every((key) => Object.hasOwn(schema.fields, key)),
        "record fields",
      );
      writer.u32(Object.keys(schema.fields).length);
      for (const [key, item] of Object.entries(schema.fields)) write(writer, item, value[key]);
      break;
    }
    case "map": {
      const keys = Object.keys(value).toSorted();
      checked(keys.length <= schema.max, "map count");
      writer.u32(keys.length);
      for (const key of keys) {
        checked(
          !unsafeKey(key) && key.length <= 128 && (!schema.numeric || /^(0|[1-9]\d*)$/.test(key)),
          "map key",
        );
        writer.string(key);
        write(writer, schema.item, value[key]);
      }
      break;
    }
    case "typed": {
      const ctor =
        schema.type === "i32" ? Int32Array : schema.type === "u16" ? Uint16Array : Uint32Array;
      checked(
        value instanceof ctor &&
          value.length <= schema.max &&
          (schema.exact === undefined || value.length === schema.exact),
        "typed length",
      );
      writer.byte(types.indexOf(schema.type));
      writer.u32(value.length);
      const channels = schema.type === "cells" ? 3 : 1;
      checked(value.length % channels === 0, "cell stride");
      for (let channel = 0; channel < channels; channel++) {
        let uniform = schema.type === "cells";
        for (let i = channel + channels; uniform && i < value.length; i += channels)
          uniform = value[i] === value[channel];
        writer.byte(Number(uniform));
        if (uniform) writer.u32(value[channel]);
        else for (let i = channel; i < value.length; i += channels) writer.u32(value[i]);
      }
      break;
    }
    default:
      throw new Error("unknown owned schema");
  }
  checked(writer.position <= MAX_CHECKPOINT_BYTES, "byte budget");
}

function read(reader, schema, charge) {
  checked(reader.byte() === kinds.indexOf(schema.kind), "field type");
  switch (schema.kind) {
    case "number": {
      const value = reader.number();
      checked(
        Number.isFinite(value) &&
          value >= schema.min &&
          value <= schema.max &&
          (!schema.integer || Number.isSafeInteger(value)),
        "number",
      );
      return value;
    }
    case "bool": {
      const value = reader.byte();
      checked(value <= 1, "boolean");
      return !!value;
    }
    case "string":
      return reader.string(schema.max, charge, schema.max > 128);
    case "literal":
      return schema.value;
    case "optional":
    case "nullable": {
      const present = reader.byte();
      checked(present <= 1, "presence");
      return present
        ? read(reader, schema.item, charge)
        : schema.kind === "optional"
          ? undefined
          : null;
    }
    case "enum": {
      const index = reader.byte();
      checked(index < schema.values.length, "enum");
      return schema.values[index];
    }
    case "list":
    case "tuple": {
      const count = reader.u32();
      checked(
        schema.kind === "tuple"
          ? count === schema.items.length
          : count <= schema.max && (schema.exact === undefined || count === schema.exact),
        "list count",
      );
      charge(128 + count * 16);
      const values = [];
      for (let i = 0; i < count; i++)
        values.push(read(reader, schema.kind === "tuple" ? schema.items[i] : schema.item, charge));
      return values;
    }
    case "record": {
      checked(reader.u32() === Object.keys(schema.fields).length, "record count");
      charge(512);
      const value = Object.create(schema.prototype ?? null);
      for (const [key, item] of Object.entries(schema.fields))
        value[key] = read(reader, item, charge);
      return value;
    }
    case "map": {
      const count = reader.u32();
      checked(count <= schema.max, "map count");
      charge(256 + count * 64);
      const value = Object.create(null);
      let previous;
      for (let i = 0; i < count; i++) {
        const key = reader.string(128, charge);
        checked(
          !unsafeKey(key) &&
            (!schema.numeric || /^(0|[1-9]\d*)$/.test(key)) &&
            (previous === undefined || key > previous),
          "map key/order",
        );
        previous = key;
        value[key] = read(reader, schema.item, charge);
      }
      return value;
    }
    case "typed": {
      checked(reader.byte() === types.indexOf(schema.type), "typed enum");
      const length = reader.u32();
      checked(
        length <= schema.max && (schema.exact === undefined || length === schema.exact),
        "typed length",
      );
      const channels = schema.type === "cells" ? 3 : 1;
      checked(length % channels === 0, "cell stride");
      charge(256 + length * (schema.type === "u16" ? 2 : 4));
      const planes = [];
      for (let channel = 0; channel < channels; channel++) {
        const uniform = reader.byte();
        checked(uniform <= 1 && (!uniform || schema.type === "cells"), "plane encoding");
        if (uniform) {
          const uniformOffset = reader.position;
          planes.push({ uniform: reader.u32(), uniformOffset });
        } else {
          planes.push({ offset: reader.position });
          reader.skip((length / channels) * 4);
        }
      }
      const value = new TypedSlice(reader, schema.type, length, planes);
      if (schema.type === "u16") checked(!value.some((item) => item > 65535), "u16 value");
      return value;
    }
    default:
      throw new Error("unknown owned schema");
  }
}

export function measure(schema, state) {
  const counter = new PageWriter(MAX_CHECKPOINT_BYTES);
  write(counter, schema, state);
  return counter.position;
}
export function encode(schema, state, size) {
  const writer = new PageWriter(size, true);
  write(writer, schema, state);
  checked(writer.position === size, "capture changed during encoding");
  return writer.pages;
}
export function scan(schema, pages, size, maximum) {
  const reader = new PageReader(pages, size);
  let allocation = 0;
  const state = read(reader, schema, (bytes) => {
    allocation += bytes;
    checked(allocation <= maximum, "staging budget");
  });
  checked(reader.position === size, "trailing bytes");
  return { state, allocation };
}
export function materialize(schema, value) {
  switch (schema.kind) {
    case "string":
      return typeof value === "string" ? value : value.materialize();
    case "typed":
      return value.materialize();
    case "optional":
    case "nullable":
      return value == null ? value : materialize(schema.item, value);
    case "record":
      for (const [key, item] of Object.entries(schema.fields))
        value[key] = materialize(item, value[key]);
      break;
    case "map":
      for (const key of Object.keys(value)) value[key] = materialize(schema.item, value[key]);
      break;
    case "list":
    case "tuple":
      for (let i = 0; i < value.length; i++)
        value[i] = materialize(schema.kind === "tuple" ? schema.items[i] : schema.item, value[i]);
      break;
  }
  return value;
}
