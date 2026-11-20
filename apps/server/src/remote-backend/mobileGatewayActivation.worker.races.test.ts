import { expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import {
  MobileActivationWorkerRepair,
  runMobileActivationWorker,
} from "./mobileGatewayActivation.worker.ts";
import { deferred, tick, workerFixture } from "./mobileGatewayActivation.worker.fixture.ts";
import {
  RemoteMobileGatewayActivation,
  RemoteMobileGatewayActivationLive,
  registeredMobileGatewayActivationState,
} from "./mobileGatewayActivation.service.ts";

it("app-only detach preserves native child, immutable assets/pin and never records exit", async () => {
  const f = workerFixture(),
    entered = deferred();
  f.input.use = async () => {
    entered.resolve();
    await new Promise<void>((resolve) =>
      f.detach.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    return 42;
  };
  const work = runMobileActivationWorker(f.input);
  await entered.promise;
  f.detach.abort(Error("App scope ends, not consent."));
  expect(await work).toEqual({ kind: "completed", disposition: "detached", value: 42 });
  expect(f.state.nativeLive).toBe(true);
  expect(f.state.pin).toBe(true);
  expect(f.state.nodeDetached).toBe(true);
  expect(f.events).not.toContain("stop");
  expect(f.events).not.toContain("record-exit");
});
it("explicit stop racing held detach must still obtain exact exit and CAS record", async () => {
  const f = workerFixture(),
    entered = deferred(),
    detached = deferred();
  f.input.use = async () => {
    entered.resolve();
    await new Promise<void>((resolve) =>
      f.detach.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    return 42;
  };
  f.native.detach = async () => {
    f.events.push("detach");
    await detached.promise;
  };
  const work = runMobileActivationWorker(f.input);
  await entered.promise;
  f.detach.abort();
  await tick();
  expect(f.events.at(-1)).toBe("detach");
  f.stop.abort(Error("Durable consent revoked."));
  detached.resolve();
  expect(await work).toMatchObject({ disposition: "exit-recorded" });
  expect(f.events.slice(-3)).toEqual(["detach", "stop", "record-exit"]);
  expect(f.state.pin).toBe(false);
});
it("late revoke while publication scope retires cannot turn earlier detach into cleanup", async () => {
  const f = workerFixture(),
    entered = deferred(),
    scopeClosing = deferred(),
    retired = deferred();
  f.input.withSelection = async (_signal, use) => {
    const value = await use(f.selection);
    scopeClosing.resolve();
    await retired.promise;
    return value;
  };
  f.input.use = async () => {
    entered.resolve();
    await new Promise<void>((resolve) =>
      f.detach.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    return 42;
  };
  const work = runMobileActivationWorker(f.input);
  await entered.promise;
  f.detach.abort();
  await scopeClosing.promise;
  f.stop.abort();
  retired.resolve();
  await expect(work).rejects.toBeInstanceOf(MobileActivationWorkerRepair);
  expect(f.state.nativeLive).toBe(true);
  expect(f.state.pin).toBe(true);
  expect(f.events).not.toContain("record-exit");
});
it("lost Stop ACK preserves pin and still joins all owned Node/proxy cleanup", async () => {
  const f = workerFixture(),
    detached = deferred();
  f.native.stop = async () => {
    f.events.push("stop");
    throw Error("Original Stop ACK unknown.");
  };
  f.native.detach = async () => {
    f.events.push("detach");
    await detached.promise;
  };
  let settled = false;
  const work = runMobileActivationWorker(f.input);
  void work.catch(() => {
    settled = true;
  });
  await tick();
  expect(f.events.at(-1)).toBe("detach");
  expect(settled).toBe(false);
  expect(f.state.pin).toBe(true);
  expect(f.events).not.toContain("record-exit");
  detached.resolve();
  await expect(work).rejects.toBeInstanceOf(MobileActivationWorkerRepair);
  expect(f.state.pin).toBe(true);
});
it("exact stop alone is insufficient if its CAS completion remains uncertain", async () => {
  const f = workerFixture();
  f.input.recordExit = async () => {
    throw Error("Original exit CAS ACK/reconciliation unknown.");
  };
  await expect(runMobileActivationWorker(f.input)).rejects.toBeInstanceOf(
    MobileActivationWorkerRepair,
  );
  expect(f.state.nativeLive).toBe(false);
  expect(f.state.pin).toBe(true);
  expect(f.state.nodeDetached).toBe(true);
});
it("one RPC interruption only detaches ACK while app-owned native work remains accepted", async () => {
  const service = await Effect.runPromise(
    Effect.service(RemoteMobileGatewayActivation).pipe(
      Effect.provide(RemoteMobileGatewayActivationLive),
    ),
  );
  const state = registeredMobileGatewayActivationState(service),
    f = workerFixture(),
    entered = deferred();
  f.input.use = async () => {
    entered.resolve();
    await new Promise<void>((resolve) =>
      f.detach.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    return 42;
  };
  let work: Promise<unknown> | undefined;
  const close = state.attach({
    activate: async () => {
      work = runMobileActivationWorker(f.input);
      await work;
      return { requestId: "controlled-fixture", status: "accepted" };
    },
    resume: async () => ({ requestId: null, status: "unavailable" }),
    stop: async () => {
      f.stop.abort();
      await work;
    },
    close: async () => {
      f.detach.abort();
      await work;
    },
  });
  const caller = Effect.runFork(service.activate({}));
  await entered.promise;
  await Effect.runPromise(Fiber.interrupt(caller));
  expect(f.detach.signal.aborted).toBe(false);
  expect(f.stop.signal.aborted).toBe(false);
  expect(f.state.nativeLive).toBe(true);
  expect(f.events).not.toContain("detach");
  await close();
  expect(f.state.nodeDetached).toBe(true);
  expect(f.state.nativeLive).toBe(true);
  expect(f.state.pin).toBe(true);
});

it("joins abandoned accepted work before reporting a selection-scope escape", async () => {
  const f = workerFixture(),
    reserved = deferred();
  f.input.reserve = async () => {
    f.state.pin = true;
    await reserved.promise;
  };
  f.input.withSelection = async (_signal, use) => {
    void use(f.selection);
    await tick();
    return 42;
  };
  let settled = false;
  const work = runMobileActivationWorker(f.input);
  void work.catch(() => {
    settled = true;
  });
  await tick();
  await tick();
  expect(settled).toBe(false);
  reserved.resolve();
  await expect(work).rejects.toBeInstanceOf(MobileActivationWorkerRepair);
  expect(f.events).not.toContain("start");
  expect(f.events).toContain("cancel-unlaunched");
});
it("fences a callback delivered after its selection scope has already retired", async () => {
  const f = workerFixture();
  let late: (() => Promise<number>) | undefined;
  f.input.withSelection = async (_signal, use) => {
    late = () => use(f.selection);
    return 42;
  };
  await expect(runMobileActivationWorker(f.input)).rejects.toBeInstanceOf(
    MobileActivationWorkerRepair,
  );
  if (!late) throw Error("Expected controlled late callback.");
  await expect(late()).rejects.toBeInstanceOf(MobileActivationWorkerRepair);
  expect(f.events).not.toContain("prepare");
  expect(f.events).not.toContain("start");
  expect(f.state.pin).toBe(false);
});
