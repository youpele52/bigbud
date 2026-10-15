import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

import { makeBackendInstance } from "./backendInstance.ts";
import { acquireStateDirLock } from "./stateDirLock.ts";

let stateDir: string;
beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "bigbud-backend-instance-"));
});
afterEach(async () => {
  await fs.rm(stateDir, { recursive: true, force: true });
});

it("assertHeld passes only while the lock still carries this instance's identity", async () => {
  const handle = await acquireStateDirLock({ stateDir, port: 0 });
  const instance = makeBackendInstance(handle, stateDir);
  expect(instance.nonce).toBe(handle.record.nonce);
  await expect(instance.assertHeld()).resolves.toBeUndefined();

  await fs.writeFile(handle.lockPath, JSON.stringify({ ...handle.record, nonce: "f".repeat(32) }));
  await expect(instance.assertHeld()).rejects.toThrow("no longer held");
  await fs.writeFile(handle.lockPath, "{");
  await expect(instance.assertHeld()).rejects.toThrow("no longer held");
  await fs.writeFile(handle.lockPath, JSON.stringify(handle.record));
  await expect(instance.assertHeld()).resolves.toBeUndefined();
  await handle.release();
  await expect(instance.assertHeld()).rejects.toThrow("no longer held");
});

it("classifyOwner applies the lock's liveness proof to recorded backends", async () => {
  const handle = await acquireStateDirLock({ stateDir, port: 0 });
  try {
    const instance = makeBackendInstance(handle, stateDir);
    expect(instance.classifyOwner(handle.record)).toBe("live");
    // Another machine: a different machine id, or (older records without one) another hostname.
    expect(
      instance.classifyOwner({
        ...handle.record,
        hostname: "elsewhere",
        machineId: `machine-v1:${"0".repeat(64)}`,
      }),
    ).toBe("foreign-host");
    expect(
      instance.classifyOwner({ ...handle.record, hostname: "elsewhere", machineId: undefined }),
    ).toBe("foreign-host");
    // This machine after a network rename: still checked by its pid and start token.
    if (handle.record.machineId)
      expect(instance.classifyOwner({ ...handle.record, hostname: "renamed" })).toBe("live");
    expect(instance.classifyOwner({ ...handle.record, pid: 2 ** 22 + 12345 })).toBe("dead");
  } finally {
    await handle.release();
  }
});
