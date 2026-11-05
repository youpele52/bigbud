import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { ResourcePreferencesStore } from "./awareness.preferences";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function store() {
  const dir = await mkdtemp(join(tmpdir(), "bigbud-resource-prefs-"));
  dirs.push(dir);
  const path = join(dir, "preferences.json");
  const preferences = new ResourcePreferencesStore(path);
  await preferences.load();
  return { preferences, path };
}

it("serializes competing revisions and persists an idempotent replay receipt", async () => {
  const { preferences, path } = await store();
  const mutation = { operation: "snooze", snoozeSeconds: 600, expectedRevision: 0 };
  const results = await Promise.allSettled([
    preferences.mutate(mutation),
    preferences.mutate({ operation: "enable", enabled: false, expectedRevision: 0 }),
  ]);
  expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
  expect(preferences.value.revision).toBe(1);
  const reloaded = new ResourcePreferencesStore(path);
  await reloaded.load();
  expect(await reloaded.mutate(mutation)).toEqual(preferences.value);
  expect(reloaded.value.revision).toBe(1);
});

it("does not publish a failed or revoked write", async () => {
  const { preferences, path } = await store();
  await expect(
    preferences.mutate({ operation: "enable", enabled: false, expectedRevision: 0 }, () => false),
  ).rejects.toThrow("revoked");
  expect(preferences.value.enabled).toBe(true);
  await expect(readFile(path)).rejects.toThrow();
  const broken = new ResourcePreferencesStore(join(path, "missing", "preferences.json"));
  await expect(
    broken.mutate({ operation: "enable", enabled: false, expectedRevision: 0 }),
  ).rejects.toThrow();
  expect(broken.value.revision).toBe(0);
});

it("preserves corrupt/unknown-version files until explicit save and never persists telemetry", async () => {
  const { path } = await store();
  await writeFile(path, '{"version":99}');
  const preferences = new ResourcePreferencesStore(path);
  await preferences.load();
  expect(preferences.diagnostic).toContain("defaults");
  await preferences.saveCooldowns({ cpu: 1000 });
  expect(await readFile(path, "utf8")).toBe('{"version":99}');
  await preferences.mutate({ operation: "enable", enabled: false, expectedRevision: 0 });
  const saved = JSON.parse(await readFile(path, "utf8"));
  expect(saved.enabled).toBe(false);
  expect(saved).not.toHaveProperty("snapshot");
  expect(preferences.diagnostic).toBeUndefined();
});

it("retries cooldown persistence after a transient storage failure", async () => {
  const { path } = await store();
  const preferences = new ResourcePreferencesStore(join(path, "preferences.json"));
  await expect(preferences.saveCooldowns({ cpu: 1000 })).rejects.toThrow();
  preferences.diagnostic = "Alert cooldown could not be saved.";
  await mkdir(path);
  await preferences.saveCooldowns({ cpu: 2000 });
  expect(preferences.cooldowns).toEqual({ cpu: 2000 });
  expect(preferences.diagnostic).toBeUndefined();
});
