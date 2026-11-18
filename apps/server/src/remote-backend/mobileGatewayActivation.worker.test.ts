import { expect, it } from "vitest";
import {
  MobileActivationWorkerRepair,
  runMobileActivationWorker,
} from "./mobileGatewayActivation.worker.ts";
import { deferred, tick, workerFixture } from "./mobileGatewayActivation.worker.fixture.ts";

it("refuses absent adapter before touching any selector/consent/key/FS callback", async () => {
  const f = workerFixture();
  const input = new Proxy(
    { ...f.input, native: undefined },
    {
      get: (target, key) => {
        if (key !== "native") throw Error("No optional work allowed.");
        return target.native;
      },
    },
  );
  expect(await runMobileActivationWorker(input)).toEqual({ kind: "unavailable" });
  expect(f.events).toEqual([]);
});
it("reserves first and joins exact native exit, CAS record and Node IO before completing", async () => {
  const f = workerFixture(),
    stopped = deferred(),
    recorded = deferred(),
    detached = deferred();
  f.native.stop = async () => {
    f.events.push("stop");
    await stopped.promise;
    f.state.nativeLive = false;
    return f.exit;
  };
  f.input.recordExit = async (_pending, _lease, exit) => {
    expect(exit).toBe(f.exit);
    f.events.push("record-exit");
    await recorded.promise;
    f.state.pin = false;
  };
  f.native.detach = async () => {
    f.events.push("detach");
    await detached.promise;
  };
  let settled = false;
  const work = runMobileActivationWorker(f.input).finally(() => {
    settled = true;
  });
  await tick();
  expect(f.events).toEqual(["select", "prepare", "reserve", "start", "use", "stop"]);
  expect(settled).toBe(false);
  stopped.resolve();
  await tick();
  expect(f.events.at(-1)).toBe("record-exit");
  expect(settled).toBe(false);
  expect(f.state.pin).toBe(true);
  recorded.resolve();
  await tick();
  expect(f.events.at(-1)).toBe("detach");
  expect(settled).toBe(false);
  detached.resolve();
  expect(await work).toEqual({ kind: "completed", disposition: "exit-recorded", value: 42 });
});
it("recovers an original lost Start ACK without starting a second child", async () => {
  const f = workerFixture();
  let starts = 0;
  f.native.start = async () => {
    starts++;
    f.state.nativeLive = true;
    throw Error("Lost original Start ACK.");
  };
  f.native.reconcile = async (pending) => {
    expect(pending).toBe(f.pending);
    return { kind: "lease", lease: f.lease };
  };
  expect(await runMobileActivationWorker(f.input)).toMatchObject({ disposition: "exit-recorded" });
  expect(starts).toBe(1);
  expect(f.state.pin).toBe(false);
  expect(f.events).toContain("record-exit");
});
it("preserves uncertain pending/pin when late original Start can still be accepted", async () => {
  const f = workerFixture();
  f.native.start = async () => {
    throw Error("Start response unknown.");
  };
  await expect(runMobileActivationWorker(f.input)).rejects.toBeInstanceOf(
    MobileActivationWorkerRepair,
  );
  // Controlled late acceptance after absent-now query: worker must not have fabricated cleanup.
  f.state.nativeLive = true;
  expect(f.state.pin).toBe(true);
  expect(f.events).not.toContain("cancel-rejected");
  expect(f.events).not.toContain("cancel-unlaunched");
  expect(f.events).not.toContain("record-exit");
  expect(f.events).not.toContain("stop");
});
it("only uses mechanically fenced original-not-accepted evidence to terminalize", async () => {
  const f = workerFixture();
  f.native.start = async () => {
    throw Error("Lost before original acceptance.");
  };
  f.native.reconcile = async () => {
    f.state.cancellationFence = true;
    return { kind: "notAccepted", evidence: f.cancelled };
  };
  await expect(runMobileActivationWorker(f.input)).rejects.toThrow(
    /Lost before original acceptance/,
  );
  expect(f.state.pin).toBe(false);
  expect(f.events).toContain("cancel-rejected");
  // The model's atomic tombstone now prevents the very same delayed Start from executing.
  const lateStart = () => {
    if (f.state.cancellationFence) throw Error("Original nonce cancelled.");
    f.state.nativeLive = true;
  };
  expect(lateStart).toThrow(/nonce cancelled/);
  expect(f.state.nativeLive).toBe(false);
});
it("keeps pin when proposed not-accepted evidence fails original cancellation verification", async () => {
  const f = workerFixture();
  f.native.start = async () => {
    throw Error("Original response unknown.");
  };
  f.native.reconcile = async () => ({ kind: "notAccepted", evidence: f.cancelled });
  f.input.cancelRejected = () => {
    throw Error("No verified atomic cancellation receipt.");
  };
  await expect(runMobileActivationWorker(f.input)).rejects.toBeInstanceOf(
    MobileActivationWorkerRepair,
  );
  expect(f.state.pin).toBe(true);
  expect(f.events).not.toContain("record-exit");
});
it("a failed original reconciliation never becomes permission to retry or remove pins", async () => {
  const f = workerFixture();
  f.native.start = async () => {
    throw Error("Lost original response.");
  };
  f.native.reconcile = () => {
    throw Error("Reconciliation transport unavailable.");
  };
  await expect(runMobileActivationWorker(f.input)).rejects.toBeInstanceOf(
    MobileActivationWorkerRepair,
  );
  expect(f.state.pin).toBe(true);
  expect(f.events).not.toContain("cancel-unlaunched");
});
it("cancels an original never-invoked permit only after reserve settles", async () => {
  const f = workerFixture(),
    reserved = deferred();
  f.input.reserve = async () => {
    f.state.pin = true;
    await reserved.promise;
  };
  const work = runMobileActivationWorker(f.input);
  let settled = false;
  void work.catch(() => {
    settled = true;
  });
  await tick();
  f.stop.abort(Error("Explicit stop before original invocation."));
  await tick();
  expect(settled).toBe(false);
  reserved.resolve();
  await expect(work).rejects.toThrow(/before original invocation/);
  expect(f.events).toContain("cancel-unlaunched");
  expect(f.events).not.toContain("start");
  expect(f.state.pin).toBe(false);
});
it("retains original native method references through a held reserve", async () => {
  const f = workerFixture(),
    reserved = deferred();
  f.input.reserve = async () => {
    f.state.pin = true;
    await reserved.promise;
  };
  const work = runMobileActivationWorker(f.input);
  await tick();
  f.native.start = async () => {
    throw Error("Foreign replacement function.");
  };
  reserved.resolve();
  expect(await work).toMatchObject({ disposition: "exit-recorded" });
  expect(f.events).toContain("start");
});
