/**
 * Process, worker, SQLite, PTY and network part of the server test-group
 * guard. Builtins are patched through their CommonJS objects and then
 * re-synced into their ESM namespaces with `syncBuiltinESMExports()`.
 */
import { createRequire } from "node:module";
import * as Path from "node:path";

import type { ReportTouch, TouchKind } from "./serverTestGroups.guard.types.ts";

type AnyFunction = (...args: Array<unknown>) => unknown;
type AnyClass = new (...args: Array<any>) => object;

const require = createRequire(import.meta.url);

const CHILD_PROCESS_FUNCTIONS = [
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
] as const;

const describeCommand = (name: string, command: unknown) =>
  `${name} ${typeof command === "string" ? Path.basename(command.split(" ")[0] ?? command) : "?"}`;

function wrapFunction(
  target: Record<string, unknown>,
  name: string,
  onCall: (args: ReadonlyArray<unknown>) => void,
): void {
  const original = target[name];
  if (typeof original !== "function") return;
  const wrapped = function (this: unknown, ...args: Array<unknown>) {
    onCall(args);
    return (original as AnyFunction).apply(this, args);
  };
  Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(original));
  target[name] = wrapped;
}

function wrapClass(
  target: Record<string, unknown>,
  name: string,
  kind: TouchKind,
  report: ReportTouch,
): void {
  const Original = target[name] as AnyClass | undefined;
  if (typeof Original !== "function") return;
  const Guarded = class extends Original {
    constructor(...args: Array<any>) {
      report({ kind, detail: `new ${name}(${typeof args[0] === "string" ? args[0] : ""})` });
      super(...args);
    }
  };
  Object.defineProperty(Guarded, "name", { value: name });
  target[name] = Guarded;
}

const tryRequire = (specifier: string): Record<string, unknown> | undefined => {
  try {
    return require(specifier) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

/** Load `node:sqlite` without printing its ExperimentalWarning in every test file. */
const requireSqliteQuietly = () => {
  const emitWarning = process.emitWarning;
  process.emitWarning = function (warning: string | Error, ...rest: Array<any>) {
    const message = typeof warning === "string" ? warning : warning.message;
    if (message.includes("SQLite is an experimental feature")) return;
    return emitWarning.call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    return tryRequire("node:sqlite");
  } finally {
    process.emitWarning = emitWarning;
  }
};

export function installRuntimeGuard(report: ReportTouch): void {
  const childProcess = require("node:child_process") as Record<string, unknown>;
  for (const name of CHILD_PROCESS_FUNCTIONS) {
    wrapFunction(childProcess, name, (args) =>
      report({ kind: "process", detail: describeCommand(name, args[0]) }),
    );
  }

  const workerThreads = require("node:worker_threads") as Record<string, unknown>;
  wrapClass(workerThreads, "Worker", "worker", report);

  const sqlite = requireSqliteQuietly();
  if (sqlite !== undefined) wrapClass(sqlite, "DatabaseSync", "sqlite", report);

  // node-pty forks natively, not through child_process. Patching its CommonJS
  // exports before first import makes the ESM facade pick up the guarded spawn.
  const nodePty = tryRequire("node-pty");
  if (nodePty !== undefined) {
    wrapFunction(nodePty, "spawn", (args) =>
      report({ kind: "pty", detail: describeCommand("pty.spawn", args[0]) }),
    );
  }

  const net = require("node:net") as typeof import("node:net");
  wrapFunction(net.Server.prototype as unknown as Record<string, unknown>, "listen", () =>
    report({ kind: "network", detail: "net.Server.listen" }),
  );
  wrapFunction(net.Socket.prototype as unknown as Record<string, unknown>, "connect", (args) =>
    report({ kind: "network", detail: `net.Socket.connect ${JSON.stringify(args[0]) ?? ""}` }),
  );
  const dgram = require("node:dgram") as typeof import("node:dgram");
  wrapFunction(dgram.Socket.prototype as unknown as Record<string, unknown>, "bind", () =>
    report({ kind: "network", detail: "dgram.Socket.bind" }),
  );
  wrapFunction(globalThis as unknown as Record<string, unknown>, "fetch", (args) =>
    report({ kind: "network", detail: `fetch ${String(args[0])}` }),
  );
}
