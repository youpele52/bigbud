import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeBackendInstance } from "./backendInstance.ts";
import {
  acquireStateDirLock,
  classifyStateDirLockOwner,
  parseStateDirLockRecord,
  STATE_DIR_LOCK_FILENAME,
  type StateDirLockProbe,
  type StateDirLockRecord,
} from "./stateDirLock.ts";
import { PROCESS_START_TOKEN_PREFIX } from "../utils/processStartToken.ts";

const T = (value: string) => `${PROCESS_START_TOKEN_PREFIX}test:${value}`;
const MACHINE = `machine-v1:${"a".repeat(64)}`;
const OTHER_MACHINE = `machine-v1:${"b".repeat(64)}`;

/** This machine after a network change renamed it: same machine id, new hostname. */
function probe(table: Map<number, string>, machineId: string | null = MACHINE): StateDirLockProbe {
  return {
    pid: 7,
    hostname: () => "macbook.fritz.box",
    machineId: () => machineId,
    isAlive: (candidate) => table.has(candidate),
    startToken: (candidate) => (table.has(candidate) ? T(table.get(candidate)!) : undefined),
  };
}
const owner = (record: Partial<StateDirLockRecord>): StateDirLockRecord => ({
  format: "bigbud.backend-lock.v1",
  pid: 41,
  startedAt: T("start-41"),
  port: 3773,
  hostname: "macbook.local",
  acquiredAt: "2026-10-15T00:00:00.000Z",
  nonce: "previous-owner",
  ...record,
});

let stateDir: string;
beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "bigbud-state-lock-machine-"));
});
afterEach(async () => {
  await fs.rm(stateDir, { recursive: true, force: true });
});
const lockPath = () => path.join(stateDir, STATE_DIR_LOCK_FILENAME);

describe("state-dir lock machine identity", () => {
  it("recognizes this machine after a hostname change; death still needs the pid proof", () => {
    const renamed = owner({ machineId: MACHINE });
    expect(classifyStateDirLockOwner(renamed, probe(new Map()))).toBe("dead");
    expect(classifyStateDirLockOwner(renamed, probe(new Map([[41, "start-41"]])))).toBe("live");
  });

  it("a different machine id is foreign even with an equal hostname", () => {
    const other = owner({ machineId: OTHER_MACHINE, hostname: "macbook.fritz.box" });
    expect(classifyStateDirLockOwner(other, probe(new Map()))).toBe("foreign-host");
  });

  it("without a machine id on either side the hostname rule is unchanged", () => {
    expect(classifyStateDirLockOwner(owner({}), probe(new Map()))).toBe("foreign-host");
    expect(classifyStateDirLockOwner(owner({ machineId: MACHINE }), probe(new Map(), null))).toBe(
      "foreign-host",
    );
    const sameName = owner({ hostname: "macbook.fritz.box" });
    expect(classifyStateDirLockOwner(sameName, probe(new Map()))).toBe("dead");
  });

  it("records the machine id and takes over a dead owner of this machine across a rename", async () => {
    await fs.writeFile(lockPath(), JSON.stringify(owner({ machineId: MACHINE })));
    const handle = await acquireStateDirLock({ stateDir, port: 1, probe: probe(new Map()) });
    expect(handle.record.machineId).toBe(MACHINE);
    expect(parseStateDirLockRecord(await fs.readFile(lockPath(), "utf8"))?.machineId).toBe(MACHINE);
    await handle.release();
  });

  it("refuses an old lock from another hostname without stealing it, naming both hosts and the fix", async () => {
    const legacy = JSON.stringify(owner({}));
    await fs.writeFile(lockPath(), legacy);
    const failure = await acquireStateDirLock({ stateDir, port: 1, probe: probe(new Map()) }).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failure?.message).toContain('"macbook.local"');
    expect(failure).toMatchObject({ reason: "state_directory_owner_unverified" });
    expect(failure?.message).toContain('"macbook.fritz.box"');
    expect(failure?.message).toContain(
      `If this is the same machine, confirm no bigbud backend is running and remove ${lockPath()}`,
    );
    expect(await fs.readFile(lockPath(), "utf8")).toBe(legacy);
  });

  it("the backend instance classifies another owner by that owner's machine id", async () => {
    const handle = await acquireStateDirLock({ stateDir, port: 1, probe: probe(new Map()) });
    const instance = makeBackendInstance(handle, stateDir, probe(new Map()));
    expect(instance.machineId).toBe(MACHINE);
    const renamed = { pid: 41, startedAt: null, hostname: "macbook.local", machineId: MACHINE };
    expect(instance.classifyOwner(renamed)).toBe("dead");
    expect(
      instance.classifyOwner({
        ...renamed,
        hostname: "macbook.fritz.box",
        machineId: OTHER_MACHINE,
      }),
    ).toBe("foreign-host");
    expect(instance.classifyOwner({ pid: 41, startedAt: null, hostname: "macbook.local" })).toBe(
      "foreign-host",
    );
    await handle.release();
  });
});
