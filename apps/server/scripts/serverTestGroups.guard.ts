/**
 * Vitest setup file for the parallel `unit` server project (and for probe
 * runs, see `updateServerTestGroups.ts`).
 *
 * It watches for the shared resources that make server tests flaky in
 * parallel: child processes, PTYs, worker threads, SQLite databases, sockets,
 * listeners, `fetch`, and filesystem writes outside the file's own `mkdtemp`
 * directories.
 *
 * - Enforce mode (default): touching any of them throws at the call site and
 *   fails the file, because the file belongs in the serial group.
 * - Probe mode (`BIGBUD_TEST_GROUP_PROBE_OUTPUT` set): touches are recorded
 *   and appended to that file as one JSON line per test file.
 *
 * Each Vitest test file runs in its own forked process (`isolate: true`), so
 * the patches and the recorded state never leak between files.
 */
import { closeSync, openSync, writeSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as Path from "node:path";

import { afterAll, expect } from "vitest";

import { installFsGuard } from "./serverTestGroups.guard.fs.ts";
import { installRuntimeGuard } from "./serverTestGroups.guard.runtime.ts";
import { PROBE_OUTPUT_ENV, type ProbeRecord, type Touch } from "./serverTestGroups.guard.types.ts";

const MAX_RECORDED_TOUCHES = 20;
// Bound before the guard patches `node:fs`. Higher-level helpers such as
// `appendFileSync` call the patched `fs.writeFileSync` internally, so they would
// report the probe's own output as a touch.
const originalOpenSync = openSync;
const originalWriteSync = writeSync;
const originalCloseSync = closeSync;
const appendProbeLine = (file: string, line: string) => {
  const descriptor = originalOpenSync(file, "a");
  try {
    originalWriteSync(descriptor, line);
  } finally {
    originalCloseSync(descriptor);
  }
};
const serverRoot = Path.resolve(import.meta.dirname, "..");
const probeOutput = process.env[PROBE_OUTPUT_ENV];
const touches: Touch[] = [];
const guardState = globalThis as { __bigbudServerTestGroupGuard?: true };

export class SerialOnlyResourceError extends Error {
  constructor(touch: Touch) {
    super(
      `[server test groups] This file touched a serial-only resource (${touch.kind}: ${touch.detail}). ` +
        "Files in the parallel `unit` project must not use processes, PTYs, workers, SQLite, " +
        "sockets or shared filesystem paths. Remove it from the parallel list by running " +
        "`bun run --cwd apps/server test:groups -- <file>`.",
    );
    this.name = "SerialOnlyResourceError";
  }
}

const report = (touch: Touch) => {
  if (touches.length < MAX_RECORDED_TOUCHES) touches.push(touch);
  if (probeOutput === undefined) throw new SerialOnlyResourceError(touch);
};

if (guardState.__bigbudServerTestGroupGuard !== true) {
  guardState.__bigbudServerTestGroupGuard = true;
  installRuntimeGuard(report);
  installFsGuard(report);
  syncBuiltinESMExports();
}

afterAll(() => {
  const absolute = expect.getState().testPath ?? "";
  const file = Path.relative(serverRoot, absolute).split(Path.sep).join("/");
  if (probeOutput !== undefined) {
    const record: ProbeRecord = { file, touches: [...touches] };
    appendProbeLine(probeOutput, `${JSON.stringify(record)}\n`);
    return;
  }
  if (touches.length > 0) {
    const summary = touches.map((touch) => `  - ${touch.kind}: ${touch.detail}`).join("\n");
    throw new Error(
      `[server test groups] ${file} ran in the parallel unit project but touched serial-only resources:\n${summary}\n` +
        `Run \`bun run --cwd apps/server test:groups -- ${file}\` to move it to the serial integration project.`,
    );
  }
});
