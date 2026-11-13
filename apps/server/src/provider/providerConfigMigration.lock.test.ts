import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { withProviderConfigMigration } from "./providerConfigMigration.ts";
import {
  acquireProviderMigrationLock,
  PROVIDER_MIGRATION_LOCK_STALE_MS,
} from "./providerConfigMigration.lock.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function configKey() {
  const root = await mkdtemp(join(tmpdir(), "bigbud-provider-migration-lock-"));
  roots.push(root);
  return {
    root,
    key: join(root, "models.json"),
    lock: join(root, "models.json.bigbud-migration.lock"),
  };
}
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;

it("recovers an ownerless lock left by a killed server", async () => {
  const { root, key, lock } = await configKey();
  await mkdir(lock);
  const old = (Date.now() - PROVIDER_MIGRATION_LOCK_STALE_MS - 1_000) / 1000;
  await utimes(lock, old, old);
  let ran = false;
  await withProviderConfigMigration(key, async () => {
    ran = true;
  });
  expect(ran).toBe(true);
  expect(await readdir(root)).toEqual([]);
});

it("recovers a fresh lock whose owner process has exited", async () => {
  const { root, key, lock } = await configKey();
  await mkdir(lock);
  await writeFile(join(lock, "owner.json"), JSON.stringify({ token: "dead", pid: deadPid() }));
  let ran = false;
  await withProviderConfigMigration(key, async () => {
    ran = true;
  });
  expect(ran).toBe(true);
  expect(await readdir(root)).toEqual([]);
});

it("waits for a live holder in another server instead of failing", async () => {
  const { key, lock } = await configKey();
  const release = await acquireProviderMigrationLock(lock);
  const order: string[] = [];
  setTimeout(() => {
    order.push("released");
    void release?.();
  }, 150);
  await withProviderConfigMigration(key, async () => {
    order.push("migrated");
  });
  expect(order).toEqual(["released", "migrated"]);
});

it("still reports a live holder that outlasts the wait", async () => {
  const { lock } = await configKey();
  const release = await acquireProviderMigrationLock(lock);
  await expect(acquireProviderMigrationLock(lock, { waitMs: 100 })).rejects.toThrow(
    /Provider migration lock unavailable/,
  );
  await release?.();
});

it("never removes a lock that another owner took over", async () => {
  const { root, lock } = await configKey();
  const release = await acquireProviderMigrationLock(lock);
  await writeFile(join(lock, "owner.json"), JSON.stringify({ token: "other", pid: process.pid }));
  await release?.();
  expect(await readdir(root)).toEqual(["models.json.bigbud-migration.lock"]);
});

it("skips migration when the configuration directory does not exist", async () => {
  const { root } = await configKey();
  const release = await acquireProviderMigrationLock(join(root, "missing", "models.json.lock"));
  expect(release).toBeUndefined();
});
