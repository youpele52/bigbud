import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import * as Net from "node:net";
import * as OS from "node:os";
import * as Path from "node:path";
import { Worker } from "node:worker_threads";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { installFsGuard } from "./serverTestGroups.guard.fs.ts";
import { installRuntimeGuard } from "./serverTestGroups.guard.runtime.ts";
import type { Touch } from "./serverTestGroups.guard.types.ts";

class Blocked extends Error {
  constructor(readonly touch: Touch) {
    super(`${touch.kind}: ${touch.detail}`);
  }
}

// The reporter throws, so a guarded operation is stopped before it runs.
const touches: Touch[] = [];
const blockedTouch = (run: () => unknown): Touch | undefined => {
  try {
    run();
  } catch (error) {
    if (error instanceof Blocked) return error.touch;
    throw error;
  }
  return undefined;
};

let tempDir = "";

beforeAll(() => {
  const report = (touch: Touch) => {
    touches.push(touch);
    throw new Blocked(touch);
  };
  installRuntimeGuard(report);
  installFsGuard(report);
  syncBuiltinESMExports();
  tempDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "bigbud-guard-test-"));
});

afterAll(() => {
  FS.rmSync(tempDir, { recursive: true, force: true });
});

describe("server test group guard", () => {
  it("stops child processes before they start", () => {
    expect(blockedTouch(() => ChildProcess.spawnSync("git", ["--version"]))).toEqual({
      kind: "process",
      detail: "spawnSync git",
    });
    expect(blockedTouch(() => ChildProcess.execFile("/usr/bin/env"))?.detail).toBe("execFile env");
  });

  it("stops worker threads, listeners and outgoing sockets", () => {
    expect(blockedTouch(() => new Worker("data:text/javascript,")))?.toMatchObject({
      kind: "worker",
    });
    expect(blockedTouch(() => Net.createServer().listen(0))?.kind).toBe("network");
    expect(blockedTouch(() => new Net.Socket().connect({ port: 9, host: "127.0.0.1" }))?.kind).toBe(
      "network",
    );
  });

  it("stops SQLite databases", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    expect(blockedTouch(() => new DatabaseSync(":memory:"))?.kind).toBe("sqlite");
  });

  it("allows writes inside the file's own mkdtemp directories", async () => {
    const nested = FS.mkdtempSync(Path.join(tempDir, "nested-"));
    FS.writeFileSync(Path.join(tempDir, "sync.txt"), "ok");
    await FSP.mkdir(Path.join(nested, "a", "b"), { recursive: true });
    await FSP.writeFile(Path.join(nested, "a", "b", "async.txt"), "ok");
    const viaPromises = await FSP.mkdtemp(Path.join(OS.tmpdir(), "bigbud-guard-promises-"));
    await FSP.writeFile(Path.join(viaPromises, "x.txt"), "ok");
    await FSP.rm(viaPromises, { recursive: true });
    expect(FS.readFileSync(Path.join(nested, "a", "b", "async.txt"), "utf8")).toBe("ok");
  });

  it("stops writes to shared paths, including through the promises API", () => {
    const shared = Path.join(OS.tmpdir(), "bigbud-guard-shared-path.txt");
    expect(blockedTouch(() => FS.writeFileSync(shared, "no"))).toEqual({
      kind: "filesystem",
      detail: `writeFile ${shared}`,
    });
    expect(blockedTouch(() => FS.openSync(shared, "a"))?.detail).toBe(`open ${shared}`);
    expect(blockedTouch(() => FS.renameSync(Path.join(tempDir, "sync.txt"), shared))?.kind).toBe(
      "filesystem",
    );
    expect(blockedTouch(() => FSP.mkdir(Path.join(OS.homedir(), "bigbud-guard-test")))?.kind).toBe(
      "filesystem",
    );
    expect(FS.existsSync(shared)).toBe(false);
  });

  it("does not treat reads as touches", () => {
    const before = touches.length;
    FS.readFileSync(import.meta.filename, "utf8");
    FS.closeSync(FS.openSync(import.meta.filename, "r"));
    expect(touches.length).toBe(before);
  });
});
