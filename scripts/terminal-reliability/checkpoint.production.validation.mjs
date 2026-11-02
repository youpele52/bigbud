import {
  scanCheckpointWire,
  PRODUCTION_CHECKPOINT_BUDGET,
} from "./checkpoint.production.budget.mjs";

export function check(condition, message) {
  if (!condition) throw new Error(`invalid checkpoint ${message}`);
}
export function integer(value, min, max) {
  check(Number.isSafeInteger(value) && value >= min && value <= max, "integer");
}
export function shape(value, names) {
  const expected = names.split(" ");
  check(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === expected.length &&
      Object.keys(value).every((key) => expected.includes(key)),
    "record fields",
  );
}
export function list(value, max, exact) {
  check(
    Array.isArray(value) && value.length <= max && (exact === undefined || value.length === exact),
    "array length",
  );
}
export function dictionary(value, max, validate) {
  check(value && typeof value === "object" && !Array.isArray(value), "dictionary");
  for (const [key, item] of Object.entries(value)) {
    check(/^(0|[1-9]\d*)$/.test(key), "dictionary key");
    integer(Number(key), 0, max - 1);
    validate(item);
  }
}
export function attributes(value, linkIds) {
  shape(value, "fg bg extended");
  integer(value.fg, -2147483648, 4294967295);
  integer(value.bg, -2147483648, 4294967295);
  extended(value.extended, linkIds);
}
export function extended(value, linkIds) {
  shape(value, "_ext _urlId");
  integer(value._ext, -2147483648, 4294967295);
  integer(value._urlId, 0, 4294967295);
  check(value._urlId === 0 || linkIds.has(value._urlId), "unknown link id");
}

function plain(value, depth = 0) {
  check(depth <= 32, "depth");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") return integer(value, -2147483648, Number.MAX_SAFE_INTEGER);
  check(value && typeof value === "object", "value type");
  for (const key of Object.keys(value)) {
    check(!["__proto__", "prototype", "constructor"].includes(key), "unsafe key");
    plain(value[key], depth + 1);
  }
}

/** JSON-only entry excludes caller getters/proxies; all validation precedes target allocation/mutation. */
export function decodeProductionCheckpoint(wire) {
  const budget = scanCheckpointWire(wire);
  const value = JSON.parse(wire);
  plain(value);
  return { value, budget };
}

export function admitMaterialization(state, budget) {
  let words = 0;
  let lines = 0;
  for (const buffer of state.buffers)
    for (const line of buffer.lines) {
      words += line.data.length;
      lines++;
    }
  const materializedBytes = words * 4 + lines * 512 + budget.decodedBytes;
  check(materializedBytes <= PRODUCTION_CHECKPOINT_BUDGET.stateBytes, "materialized state budget");
  check(
    budget.encodedBytes + budget.decodedBytes + materializedBytes <=
      PRODUCTION_CHECKPOINT_BUDGET.stagingBytes,
    "materialization staging budget",
  );
  return materializedBytes;
}
