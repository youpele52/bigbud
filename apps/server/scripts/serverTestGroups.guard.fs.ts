/**
 * Filesystem part of the server test-group guard. A write counts as shared
 * (serial-only) unless it lands inside a directory this test process created
 * with `mkdtemp`, which is unique per call and therefore safe in parallel.
 */
import { createRequire } from "node:module";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";

import type { ReportTouch } from "./serverTestGroups.guard.types.ts";

type AnyFunction = (...args: Array<unknown>) => unknown;
type PathPicker = (args: ReadonlyArray<unknown>) => ReadonlyArray<unknown>;

const require = createRequire(import.meta.url);
const fs = require("node:fs") as typeof import("node:fs") & Record<string, unknown>;
const fsPromises = fs.promises as unknown as Record<string, unknown>;
const realpathSync = fs.realpathSync.native;

const first: PathPicker = (args) => [args[0]];
const second: PathPicker = (args) => [args[1]];
const both: PathPicker = (args) => [args[0], args[1]];

/** Mutating operations and which arguments are the written paths. */
const WRITE_OPERATIONS: ReadonlyArray<readonly [string, PathPicker]> = [
  ["writeFile", first],
  ["appendFile", first],
  ["mkdir", first],
  ["rm", first],
  ["rmdir", first],
  ["unlink", first],
  ["truncate", first],
  ["chmod", first],
  ["chown", first],
  ["lchown", first],
  ["utimes", first],
  ["lutimes", first],
  ["copyFile", second],
  ["cp", second],
  ["rename", both],
  ["symlink", second],
  ["link", second],
];

const WRITE_FLAGS = /[wa+]/;

const toPathString = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.protocol === "file:" ? fileURLToPath(value) : undefined;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return undefined; // file descriptors and FileHandles were already opened
};

export function installFsGuard(report: ReportTouch): void {
  const uniqueRoots = new Set<string>();
  const addRoot = (directory: unknown) => {
    if (typeof directory !== "string") return;
    uniqueRoots.add(Path.resolve(directory));
    try {
      uniqueRoots.add(realpathSync(directory));
    } catch {
      // The directory may already be gone; the unresolved form is still recorded.
    }
  };
  const isUnique = (target: string) => {
    if (target === "/dev/null") return true;
    for (const root of uniqueRoots) {
      if (target === root || target.startsWith(`${root}${Path.sep}`)) return true;
    }
    return false;
  };
  const check = (operation: string, values: ReadonlyArray<unknown>) => {
    for (const value of values) {
      const raw = toPathString(value);
      if (raw === undefined) continue;
      const target = Path.resolve(raw);
      if (!isUnique(target)) report({ kind: "filesystem", detail: `${operation} ${target}` });
    }
  };

  const wrap = (
    target: Record<string, unknown>,
    name: string,
    before: (args: ReadonlyArray<unknown>) => void,
    after?: (result: unknown) => unknown,
  ) => {
    const original = target[name];
    if (typeof original !== "function") return;
    const wrapped = function (this: unknown, ...args: Array<unknown>) {
      before(args);
      const result = (original as AnyFunction).apply(this, args);
      return after === undefined ? result : after(result);
    };
    Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(original));
    target[name] = wrapped;
  };

  for (const [operation, pick] of WRITE_OPERATIONS) {
    const before = (args: ReadonlyArray<unknown>) => check(operation, pick(args));
    wrap(fs, operation, before);
    wrap(fs, `${operation}Sync`, before);
    wrap(fsPromises, operation, before);
  }

  const checkOpen = (args: ReadonlyArray<unknown>) => {
    const flags = args[1];
    if (typeof flags === "string" && WRITE_FLAGS.test(flags)) check("open", [args[0]]);
    if (
      typeof flags === "number" &&
      (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0
    ) {
      check("open", [args[0]]);
    }
  };
  wrap(fs, "open", checkOpen);
  wrap(fs, "openSync", checkOpen);
  wrap(fsPromises, "open", checkOpen);
  wrap(fs, "createWriteStream", (args) => {
    const options = args[1];
    const flags =
      typeof options === "object" && options !== null && "flags" in options
        ? (options as { flags?: unknown }).flags
        : undefined;
    if (flags === undefined || (typeof flags === "string" && WRITE_FLAGS.test(flags))) {
      check("createWriteStream", [args[0]]);
    }
  });

  // mkdtemp directories are unique per call: writes below them are parallel-safe.
  wrap(
    fs,
    "mkdtempSync",
    () => undefined,
    (directory) => (addRoot(directory), directory),
  );
  wrap(
    fsPromises,
    "mkdtemp",
    () => undefined,
    (pending) => (pending as Promise<unknown>).then((directory) => (addRoot(directory), directory)),
  );
  const originalMkdtemp = fs.mkdtemp as unknown as AnyFunction;
  const mkdtemp = function (this: unknown, ...args: Array<unknown>) {
    const callback = args.at(-1);
    if (typeof callback === "function") {
      args[args.length - 1] = (error: unknown, directory: unknown) => {
        if (error === null || error === undefined) addRoot(directory);
        (callback as AnyFunction)(error, directory);
      };
    }
    return originalMkdtemp.apply(this, args);
  };
  Object.defineProperties(mkdtemp, Object.getOwnPropertyDescriptors(originalMkdtemp));
  fs.mkdtemp = mkdtemp as unknown as typeof fs.mkdtemp;
}
