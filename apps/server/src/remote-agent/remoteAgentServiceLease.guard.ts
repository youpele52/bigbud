import { posix } from "node:path";
import { hasLocalSupervisorServiceControls } from "../remote-backend/localSupervisorService.paths.ts";
export type NativeLeaseGuardValue = string | boolean | number;
export type NativeLeaseGuardPredicate =
  | { readonly path: ReadonlyArray<string>; readonly values: ReadonlyArray<NativeLeaseGuardValue> }
  | {
      readonly path: ReadonlyArray<string>;
      readonly valueFrom: "configurationSha256" | "guardSha256";
    };
export interface NativeLeaseGuardAnchor {
  readonly path: string;
  readonly dev: string;
  readonly ino: string;
  readonly uid: string;
  readonly mode: 0o700 | 0o750 | 0o755;
}
export interface NativeLeaseGuardSelection {
  readonly path: ReadonlyArray<string>;
  readonly key: string;
  readonly value: string;
  readonly maxRows?: number;
  readonly all: ReadonlyArray<NativeLeaseGuardPredicate>;
}
export interface NativeLeaseGuardV2 {
  readonly version: 2;
  readonly file: string;
  readonly anchors: ReadonlyArray<NativeLeaseGuardAnchor>;
  readonly all: ReadonlyArray<NativeLeaseGuardPredicate>;
  readonly select: ReadonlyArray<NativeLeaseGuardSelection>;
}
function fields(value: object, names: ReadonlyArray<string>, required = names) {
  if (
    Object.keys(value).some((key) => !names.includes(key)) ||
    required.some((key) => !(key in value))
  )
    throw Error("Unexpected native guard fields.");
}
function text(value: string, max: number) {
  if (
    typeof value !== "string" ||
    !value.length ||
    Buffer.byteLength(value) > max ||
    hasLocalSupervisorServiceControls(value)
  )
    throw Error("Invalid native guard text.");
  return value;
}
function path(value: string) {
  text(value, 4096);
  if (!posix.isAbsolute(value) || posix.normalize(value) !== value || value.includes("//"))
    throw Error("Invalid original native guard path.");
  return value;
}
function keys(value: ReadonlyArray<string>) {
  if (!Array.isArray(value) || !value.length || value.length > 16)
    throw Error("Native guard path exceeds its budget.");
  return value.map((key) => text(key, 64));
}
function decimal(value: string, max: bigint) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > max)
    throw Error("Invalid native guard anchor tuple.");
  return value;
}
function predicates(values: ReadonlyArray<NativeLeaseGuardPredicate>) {
  if (!Array.isArray(values) || !values.length || values.length > 32)
    throw Error("Native guard predicate budget exceeded.");
  return values.map((value) => {
    fields(value, "valueFrom" in value ? ["path", "valueFrom"] : ["path", "values"]);
    const field = keys(value.path);
    if ("valueFrom" in value) {
      if (
        "values" in value ||
        (value.valueFrom !== "configurationSha256" && value.valueFrom !== "guardSha256")
      )
        throw Error("Invalid native computed guard source.");
      return { path: field, valueFrom: value.valueFrom };
    }
    if (!Array.isArray(value.values) || !value.values.length || value.values.length > 4)
      throw Error("Invalid native guard comparisons.");
    const expected = value.values.map((item: unknown) => {
      if (typeof item === "string") {
        if (Buffer.byteLength(item) > 2048) throw Error("Native guard value too large.");
        return item;
      }
      if (
        typeof item === "boolean" ||
        (typeof item === "number" && Number.isSafeInteger(item) && item >= 0)
      )
        return item;
      throw Error("Native guard comparison must be a bounded primitive.");
    });
    return { path: field, values: expected };
  });
}
/** Mechanical encoding only. Actual factory derives predicates from original publication/CAS. */
export function encodeNativeLeaseGuardV2(input: NativeLeaseGuardV2): Uint8Array {
  fields(input, ["version", "file", "anchors", "all", "select"]);
  if (
    input.version !== 2 ||
    !Array.isArray(input.anchors) ||
    !input.anchors.length ||
    input.anchors.length > 8 ||
    !Array.isArray(input.select) ||
    input.select.length > 4
  )
    throw Error("Invalid native guard shape.");
  const file = path(input.file),
    seen = new Set<string>();
  const anchors = input.anchors.map((anchor) => {
    fields(anchor, ["path", "dev", "ino", "uid", "mode"]);
    const name = path(anchor.path);
    if (seen.has(name) || ![0o700, 0o750, 0o755].includes(anchor.mode))
      throw Error("Invalid native guard directory anchors.");
    seen.add(name);
    return {
      path: name,
      dev: decimal(anchor.dev, 0xffffffffffffffffn),
      ino: decimal(anchor.ino, 0xffffffffffffffffn),
      uid: decimal(anchor.uid, 0xffffffffn),
      mode: anchor.mode,
    };
  });
  if (!seen.has(posix.dirname(file)))
    throw Error("Native guard must anchor its original registry parent.");
  const all = predicates(input.all);
  let count = all.length;
  const select = input.select.map((value) => {
    fields(value, ["path", "key", "value", "maxRows", "all"], ["path", "key", "value", "all"]);
    const selected = predicates(value.all);
    count += selected.length;
    const maxRows = value.maxRows ?? 32;
    if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 128)
      throw Error("Native guard selected-array budget exceeded.");
    return {
      path: keys(value.path),
      key: text(value.key, 64),
      value: text(value.value, 128),
      maxRows,
      all: selected,
    };
  });
  if (count > 32) throw Error("Native guard total predicate budget exceeded.");
  const bytes = Buffer.from(JSON.stringify({ version: 2, file, anchors, all, select }), "utf8");
  if (bytes.length > 16384) throw Error("Native guard serialized bytes exceed bound.");
  return Uint8Array.from(bytes);
}
