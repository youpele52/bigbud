import { readFile, readdir, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { expect, it, vi } from "vitest";

import { createDevPortCoordinator } from "./DevPortCoordinator";
import { setup, worker } from "./DevPortCoordinator.test.helpers";

it("scopes canonical roots together regardless of instance offsets", async () => {
  const { root, coordinator } = await setup();
  await symlink(root, path.join(root, "alias"), "dir");
  vi.stubEnv("BIGBUD_DEV_INSTANCE_OFFSET", "999");
  try {
    const alias = await createDevPortCoordinator(
      path.join(root, "alias"),
      path.join(root, "storage"),
    );
    expect(alias.directory).toBe(coordinator.directory);
    const defaults = await createDevPortCoordinator(root);
    expect(path.dirname(path.dirname(defaults.directory))).toBe(tmpdir());
    expect(path.basename(path.dirname(defaults.directory))).toMatch(
      /^bigbud-dev-ports-[a-f0-9]{32}$/,
    );
    // The default namespace is also exclusively owned by this temporary root.
    const { rm } = await import("node:fs/promises");
    await rm(defaults.directory, { recursive: true });
  } finally {
    vi.unstubAllEnvs();
  }
});

it("excludes independent Node processes and preserves every shared counter update", async () => {
  const { root, coordinator } = await setup();
  await writeFile(path.join(root, "counter"), "0");
  const contenders = Array.from({ length: 5 }, () => worker(root, "stress"));
  await Promise.all(contenders.map((item) => item.message("ready")));
  for (const item of contenders) item.child.send("start");
  for (const item of contenders) expect(await item.done, item.stderr).toBe(0);
  expect(await readFile(path.join(root, "counter"), "utf8")).toBe("75");
  expect(await readdir(path.join(coordinator.directory, "slots"))).toEqual([]);
}, 15_000);

it.each(["choosing", "hold"])("recovers after an owner dies during %s", async (mode) => {
  const { root, coordinator } = await setup();
  const owner = worker(root, mode);
  await owner.message(mode === "choosing" ? "choosing" : "locked");
  let entered = false;
  const acquisition = coordinator.withLock(async () => {
    entered = true;
  });
  await delay(50);
  expect(entered).toBe(false);
  await owner.kill();
  await acquisition;
  expect(entered).toBe(true);
  expect(await readdir(path.join(coordinator.directory, "slots"))).toEqual([]);
});

it("rereads a choosing owner's published ticket before comparing priority", async () => {
  const { root, coordinator } = await setup();
  const owner = worker(root, "choosing");
  await owner.message("choosing");
  let entered = false;
  const acquisition = coordinator.withLock(async () => {
    entered = true;
  });
  await delay(50);
  expect(entered).toBe(false);
  owner.child.send("resume choosing");
  await acquisition;
  expect(entered).toBe(true);
  await owner.message("locked");
  owner.child.send("release");
  expect(await owner.done, owner.stderr).toBe(0);
});

it("times out and removes only its slot without stealing even a very old live lock", async () => {
  const { root, coordinator } = await setup();
  const owner = worker(root, "hold");
  await owner.message("locked");
  const slots = path.join(coordinator.directory, "slots");
  const [name] = await readdir(slots);
  expect(name).toBeDefined();
  await utimes(path.join(slots, name!), new Date(0), new Date(0));
  const action = vi.fn(async () => undefined);
  await expect(coordinator.withLock(action)).rejects.toThrow("acquisition timed out");
  expect(action).not.toHaveBeenCalled();
  expect(await readdir(slots)).toEqual([name]);
  await owner.kill();
  await coordinator.withLock(action);
  expect(action).toHaveBeenCalledOnce();
}, 35_000);

it("cancels acquisition, including pre-abort, and removes only its own slot", async () => {
  const { root, coordinator } = await setup();
  const owner = worker(root, "choosing");
  await owner.message("choosing");
  const slots = path.join(coordinator.directory, "slots");
  const original = await readdir(slots);
  const controller = new AbortController();
  const action = vi.fn(async () => undefined);
  const waiting = coordinator.withLock(action, controller.signal);
  const rejected = expect(waiting).rejects.toThrow();
  await delay(30);
  controller.abort();
  await rejected;
  await expect(coordinator.withLock(action, controller.signal)).rejects.toThrow();
  expect(action).not.toHaveBeenCalled();
  expect(await readdir(slots)).toEqual(original);
});

it("holds exclusion until an aborted action actually returns and cleans up thrown actions", async () => {
  const { coordinator } = await setup();
  const controller = new AbortController();
  await coordinator.withLock(async () => {
    controller.abort();
    await expect(
      coordinator.withLock(async () => {
        throw new Error("must not enter");
      }, AbortSignal.timeout(30)),
    ).rejects.not.toThrow("must not enter");
  }, controller.signal);
  await expect(
    coordinator.withLock(async () => {
      throw new Error("action failed");
    }),
  ).rejects.toThrow("action failed");
  await expect(coordinator.withLock(async () => 42)).resolves.toBe(42);
  expect(await readdir(path.join(coordinator.directory, "slots"))).toEqual([]);
});

it.each(["unknown.json", `${process.pid}-11111111-1111-4111-8111-111111111111.json`])(
  "fails closed on unknown or corrupt slots: %s",
  async (name) => {
    const { coordinator } = await setup();
    await writeFile(path.join(coordinator.directory, "slots", name), "{");
    const action = vi.fn(async () => undefined);
    await expect(coordinator.withLock(action)).rejects.toThrow();
    expect(action).not.toHaveBeenCalled();
    expect(await readdir(path.join(coordinator.directory, "slots"))).toEqual([name]);
  },
);
