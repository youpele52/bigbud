import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquireStateDirLock,
  classifyStateDirLockOwner,
  parseStateDirLockRecord,
  STATE_DIR_LOCK_FILENAME,
  StateDirLockError,
  type StateDirLockProbe,
  type StateDirLockRecord,
} from "./stateDirLock.ts";
import { PROCESS_START_TOKEN_PREFIX } from "../utils/processStartToken.ts";

const HOST = "fixture-host";
/** A comparable (current-format) synthetic start token. */
const T = (value: string) => `${PROCESS_START_TOKEN_PREFIX}test:${value}`;

/** Synthetic process table: pid -> start token (undefined = alive but unobtainable). */
function makeProbe(pid: number, table: Map<number, string | undefined>): StateDirLockProbe {
  return {
    pid,
    hostname: () => HOST,
    isAlive: (candidate) => table.has(candidate),
    startToken: (candidate) => {
      const value = table.get(candidate);
      return value === undefined ? undefined : T(value);
    },
  };
}

let stateDir: string;
beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "bigbud-state-lock-"));
});
afterEach(async () => {
  await fs.rm(stateDir, { recursive: true, force: true });
});

const lockPath = () => path.join(stateDir, STATE_DIR_LOCK_FILENAME);
const readRecord = async () =>
  parseStateDirLockRecord(await fs.readFile(lockPath(), "utf8")) as StateDirLockRecord;
const writeRecord = (record: Partial<StateDirLockRecord>) =>
  fs.writeFile(
    lockPath(),
    JSON.stringify({
      format: "bigbud.backend-lock.v1",
      pid: 41,
      startedAt: T("start-41"),
      port: 3773,
      hostname: HOST,
      acquiredAt: "2026-10-15T00:00:00.000Z",
      nonce: "previous-owner",
      ...record,
    }),
  );
const leftovers = async () =>
  (await fs.readdir(stateDir)).filter((name) => name !== STATE_DIR_LOCK_FILENAME);

describe("acquireStateDirLock", () => {
  it("creates a complete owner record on a fresh state directory and releases it", async () => {
    const table = new Map([[100, "start-100"]]);
    const handle = await acquireStateDirLock({
      stateDir,
      port: 3774,
      probe: makeProbe(100, table),
    });
    expect(await readRecord()).toMatchObject({
      pid: 100,
      startedAt: T("start-100"),
      port: 3774,
      hostname: HOST,
      nonce: handle.record.nonce,
    });
    expect(await leftovers()).toEqual([]);
    await handle.release();
    await handle.release();
    await expect(fs.stat(lockPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a live owner with its pid, port and the BIGBUD_HOME alternative", async () => {
    const table = new Map([
      [41, "start-41"],
      [100, "start-100"],
    ]);
    await writeRecord({ pid: 41, port: 3773 });
    const attempt = acquireStateDirLock({ stateDir, port: 3774, probe: makeProbe(100, table) });
    await expect(attempt).rejects.toBeInstanceOf(StateDirLockError);
    await expect(attempt).rejects.toMatchObject({ reason: "state_directory_in_use" });
    await expect(attempt).rejects.toThrow(
      `Another bigbud backend (pid 41, port 3773) owns ${stateDir}; stop it or use a different BIGBUD_HOME.`,
    );
    expect((await readRecord()).nonce).toBe("previous-owner");
  });

  it.each([
    ["exited (ESRCH)", new Map([[100, "start-100"]])],
    [
      "PID reused by a process with a different start time",
      new Map([
        [41, "a-later-start"],
        [100, "start-100"],
      ]),
    ],
  ])("atomically replaces a dead owner: %s", async (_label, table) => {
    await writeRecord({ pid: 41, startedAt: T("start-41") });
    const handle = await acquireStateDirLock({
      stateDir,
      port: 3774,
      probe: makeProbe(100, table),
    });
    expect(await readRecord()).toMatchObject({ pid: 100, nonce: handle.record.nonce });
    expect(await leftovers()).toEqual([]);
    await handle.release();
  });

  it.each([
    ["the live PID's start time is unobtainable", { startedAt: T("start-41") }, undefined],
    ["the record has no start time", { startedAt: null }, "start-41"],
    // Written by an older build: TZ/locale-dependent `ps lstart` text is never comparable.
    ["the record has a legacy start token", { startedAt: "Thu_Oct_15_05:47:29_2026" }, "other"],
    ["the record has a placeholder start token", { startedAt: "pid:41" }, "other"],
  ] as const)("fails closed when %s", async (_label, record, liveToken) => {
    await writeRecord(record);
    const table = new Map<number, string | undefined>([
      [41, liveToken],
      [100, "start-100"],
    ]);
    await expect(
      acquireStateDirLock({ stateDir, port: 3774, probe: makeProbe(100, table) }),
    ).rejects.toThrow("Another bigbud backend (pid 41, port 3773)");
  });

  it("names a foreign host explicitly instead of a misleading live owner", async () => {
    await writeRecord({ hostname: "renamed-host" });
    const table = new Map([[100, "start-100"]]); // PID 41 is not alive here, but it is not ours.
    await expect(
      acquireStateDirLock({ stateDir, port: 3774, probe: makeProbe(100, table) }),
    ).rejects.toThrow(`was written on host "renamed-host" (pid 41, port 3773), not this host`);
    expect((await readRecord()).nonce).toBe("previous-owner");
  });

  it("replaces a legacy-token record only when its PID is genuinely gone", async () => {
    await writeRecord({ startedAt: "Thu_Oct_15_05:47:29_2026" });
    const handle = await acquireStateDirLock({
      stateDir,
      port: 3774,
      probe: makeProbe(100, new Map([[100, "start-100"]])),
    });
    expect((await readRecord()).nonce).toBe(handle.record.nonce);
    expect(await leftovers()).toEqual([]);
    await handle.release();
  });

  it("refuses an unreadable lock instead of guessing", async () => {
    await fs.writeFile(lockPath(), "{not json");
    await expect(
      acquireStateDirLock({ stateDir, port: 3774, probe: makeProbe(100, new Map()) }),
    ).rejects.toThrow("is unreadable. If no bigbud backend is running, delete it");
  });

  it("refuses a second acquisition by the same live process", async () => {
    const table = new Map([[100, "start-100"]]);
    const first = await acquireStateDirLock({ stateDir, port: 3774, probe: makeProbe(100, table) });
    await expect(
      acquireStateDirLock({ stateDir, port: 3775, probe: makeProbe(100, table) }),
    ).rejects.toThrow("Another bigbud backend (pid 100, port 3774)");
    await first.release();
  });

  it.each([false, true])(
    "admits exactly one of many concurrent starters (stale previous owner=%s)",
    async (stale) => {
      if (stale) await writeRecord({ pid: 41 });
      const pids = Array.from({ length: 12 }, (_, index) => 200 + index);
      const table = new Map(pids.map((pid) => [pid, `start-${pid}`] as const));
      const results = await Promise.allSettled(
        pids.map((pid) =>
          acquireStateDirLock({ stateDir, port: pid, probe: makeProbe(pid, table) }),
        ),
      );
      const winners = results.filter((result) => result.status === "fulfilled");
      expect(winners).toHaveLength(1);
      for (const result of results)
        if (result.status === "rejected") expect(result.reason).toBeInstanceOf(StateDirLockError);
      const winner = (winners[0] as PromiseFulfilledResult<{ record: StateDirLockRecord }>).value;
      expect((await readRecord()).nonce).toBe(winner.record.nonce);
      expect(await leftovers()).toEqual([]);
    },
  );

  it("a stale release never removes a successor's lock", async () => {
    const table = new Map([[100, "start-100"]]);
    const handle = await acquireStateDirLock({
      stateDir,
      port: 3774,
      probe: makeProbe(100, table),
    });
    await fs.rm(lockPath());
    await writeRecord({ pid: 300, nonce: "successor" });
    await handle.release();
    expect((await readRecord()).nonce).toBe("successor");
  });
});

describe("classifyStateDirLockOwner", () => {
  it("treats the real current process as live", () => {
    const record = parseStateDirLockRecord(
      JSON.stringify({
        format: "bigbud.backend-lock.v1",
        pid: process.pid,
        startedAt: null,
        port: 1,
        hostname: os.hostname(),
        acquiredAt: "now",
        nonce: "n",
      }),
    )!;
    expect(
      classifyStateDirLockOwner(record, {
        pid: process.pid,
        hostname: () => os.hostname(),
        isAlive: () => true,
        startToken: () => undefined,
      }),
    ).toBe("live");
  });
});
