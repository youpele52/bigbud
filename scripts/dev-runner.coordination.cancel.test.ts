import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { isDevPortAvailable } from "@bigbud/shared/DevPortAvailability";
import {
  createDevPortCoordinator,
  readDevPortReservations,
  reserveDevPort,
} from "@bigbud/shared/DevPortCoordinator";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { afterEach, expect, it, vi } from "vitest";

import { reserveRunnerPorts } from "./dev-runner.coordination.ts";

vi.mock("@bigbud/shared/DevPortAvailability", () => ({ isDevPortAvailable: vi.fn() }));
vi.mock("@bigbud/shared/DevPortCoordinator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bigbud/shared/DevPortCoordinator")>();
  return { ...actual, reserveDevPort: vi.fn(actual.reserveDevPort) };
});

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

function barrier() {
  return Promise.withResolvers<void>();
}

async function setup() {
  vi.mocked(isDevPortAvailable).mockResolvedValue(true);
  const root = await mkdtemp(path.join(tmpdir(), "bigbud-runner-cancel-test-"));
  roots.push(root);
  const storageRoot = path.join(root, "storage");
  return {
    coordinator: await createDevPortCoordinator(root, storageRoot),
    acquire: reserveRunnerPorts({
      mode: "dev:web",
      startOffset: 0,
      hasExplicitServerPort: false,
      hasExplicitDevUrl: false,
      dryRun: false,
      repoRoot: root,
      storageRoot,
    }),
  };
}

async function promptly(promise: Promise<unknown>) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Cancellation did not settle promptly")),
          1_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.clearAllMocks();
});

it("interrupts actual mutex contention promptly, removes its slot, and never allocates afterward", async () => {
  const { coordinator, acquire } = await setup();
  const entered = barrier();
  const release = barrier();
  const holding = coordinator.withLock(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const slots = path.join(coordinator.directory, "slots");
  const original = await readdir(slots);
  const runner = Effect.runFork(Effect.scoped(acquire));
  cleanups.push(async () => {
    release.resolve();
    await holding;
    await Effect.runPromise(Fiber.interrupt(runner));
  });
  await expect.poll(async () => (await readdir(slots)).length).toBe(2);

  await promptly(Effect.runPromise(Fiber.interrupt(runner)));
  expect(await readdir(slots)).toEqual(original);
  expect(reserveDevPort).not.toHaveBeenCalled();
  expect(isDevPortAvailable).not.toHaveBeenCalled();
  release.resolve();
  await holding;
  expect(await coordinator.withLock(() => readDevPortReservations(coordinator))).toEqual([]);
  expect(await readdir(slots)).toEqual([]);
  expect(reserveDevPort).not.toHaveBeenCalled();
});

it("joins an in-flight selection before unlocking and skips publication after interruption", async () => {
  const { coordinator, acquire } = await setup();
  const selecting = barrier();
  const finishSelection = barrier();
  vi.mocked(isDevPortAvailable).mockImplementationOnce(async () => {
    selecting.resolve();
    await finishSelection.promise;
    return true;
  });
  const runner = Effect.runFork(Effect.scoped(acquire));
  cleanups.push(async () => {
    finishSelection.resolve();
    await Effect.runPromise(Fiber.interrupt(runner));
  });
  await selecting.promise;
  let interrupted = false;
  const stopping = Effect.runPromise(Fiber.interrupt(runner)).then(() => {
    interrupted = true;
  });
  await delay(30);
  expect(interrupted).toBe(false);
  expect(await readdir(path.join(coordinator.directory, "slots"))).toHaveLength(1);
  await expect(
    coordinator.withLock(async () => undefined, AbortSignal.timeout(30)),
  ).rejects.toThrow();
  finishSelection.resolve();
  await promptly(stopping);
  expect(reserveDevPort).not.toHaveBeenCalled();
  expect(await coordinator.withLock(() => readDevPortReservations(coordinator))).toEqual([]);
});

it("joins late publication and releases its lease before interrupted scope closure completes", async () => {
  const { coordinator, acquire } = await setup();
  const actual = await vi.importActual<typeof import("@bigbud/shared/DevPortCoordinator")>(
    "@bigbud/shared/DevPortCoordinator",
  );
  const published = barrier();
  const finishPublication = barrier();
  vi.mocked(reserveDevPort).mockImplementationOnce(async (...args) => {
    const lease = await actual.reserveDevPort(...args);
    published.resolve();
    await finishPublication.promise;
    return lease;
  });
  const runner = Effect.runFork(Effect.scoped(acquire));
  cleanups.push(async () => {
    finishPublication.resolve();
    await Effect.runPromise(Fiber.interrupt(runner));
  });
  await published.promise;
  let interrupted = false;
  const stopping = Effect.runPromise(Fiber.interrupt(runner)).then(() => {
    interrupted = true;
  });
  await delay(30);
  expect(interrupted).toBe(false);
  expect(await readdir(path.join(coordinator.directory, "reservations"))).toHaveLength(1);
  expect(await readdir(path.join(coordinator.directory, "slots"))).toHaveLength(1);
  finishPublication.resolve();
  await promptly(stopping);
  expect(await readdir(path.join(coordinator.directory, "slots"))).toEqual([]);
  expect(await coordinator.withLock(() => readDevPortReservations(coordinator))).toEqual([]);
});

it("retains the parent reservation until later child finalizers finish", async () => {
  const { coordinator, acquire } = await setup();
  const childReady = barrier();
  const childStopping = barrier();
  const finishChild = barrier();
  let token: string | undefined;
  const runner = Effect.runFork(
    Effect.scoped(
      Effect.gen(function* () {
        token = (yield* acquire).webReservation;
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            childStopping.resolve();
            await finishChild.promise;
          }),
        );
        childReady.resolve();
        return yield* Effect.never;
      }),
    ),
  );
  cleanups.push(async () => {
    finishChild.resolve();
    await Effect.runPromise(Fiber.interrupt(runner));
  });
  await childReady.promise;
  const stopping = Effect.runPromise(Fiber.interrupt(runner));
  await childStopping.promise;
  expect(await coordinator.withLock(() => readDevPortReservations(coordinator))).toEqual([
    expect.objectContaining({ token }),
  ]);
  finishChild.resolve();
  await promptly(stopping);
  expect(await coordinator.withLock(() => readDevPortReservations(coordinator))).toEqual([]);
});
