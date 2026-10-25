import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { expect, it, vi } from "vitest";
import { V2ActivationJobs } from "./PluginSetup.activation.jobs.ts";
import { makeV2ActivationJobsFixture as fixture } from "./PluginSetup.activation.jobs.fixture.ts";
import { deferred } from "./Test.fixtures.ts";
import type { borrowV2SharedService } from "./SharedService.connection.ts";
import type { V2ActivationHandle } from "./PluginSetup.activation.jobs.ts";

it("foreground wait timeout retains job-owned authority/connection, and revocation after return closes/releases exactly once", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const closed = vi.fn(async () => {}),
    entered = deferred<void>();
  let signal: AbortSignal | undefined;
  const jobs = new V2ActivationJobs(
    f.consent,
    async (job) => {
      signal = job.signal;
      job.phase("waiting-for-idle");
      entered.resolve();
      await new Promise<void>((resolve) =>
        job.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
    async () => ({ close: closed }) as unknown as Awaited<ReturnType<typeof borrowV2SharedService>>,
  );
  try {
    const handle = jobs.request(f.scope);
    await entered.promise;
    const waiting = jobs.wait(handle, f.scope);
    await vi.advanceTimersByTimeAsync(30000);
    expect(await waiting).toMatchObject({ state: "waiting-for-idle", jobId: handle.jobId });
    expect(closed).not.toHaveBeenCalled();
    await Effect.runPromise(
      f.settings.updateSettings({
        providers: { opencodeV2: { nativePluginConfigRoot: "/different-root" } },
      }),
    );
    expect(signal?.aborted).toBe(true);
    await jobs.close();
    expect(closed).toHaveBeenCalledTimes(1);
  } finally {
    await jobs.close();
    f.consent.close();
    vi.useRealTimers();
  }
});

it("Effect RPC completion retains a timed-out continuation, while actual RPC interruption cancels only its issued interest", async () => {
  vi.useFakeTimers();
  const f = await fixture(),
    entered = deferred<void>(),
    held = deferred<void>(),
    closed = vi.fn(async () => {});
  const jobs = new V2ActivationJobs(
    f.consent,
    async (job) => {
      job.phase("waiting-for-idle");
      entered.resolve();
      await held.promise;
    },
    async () => ({ close: closed }) as unknown as Awaited<ReturnType<typeof borrowV2SharedService>>,
  );
  let callerSignal: AbortSignal | undefined, handle: V2ActivationHandle | undefined;
  try {
    const rpc = Effect.runPromise(
      Effect.promise(async (signal) => {
        callerSignal = signal;
        handle = jobs.request(f.scope, signal);
        return jobs.wait(handle, f.scope, signal);
      }),
    );
    await entered.promise;
    await vi.advanceTimersByTimeAsync(30000);
    expect(await rpc).toMatchObject({ state: "waiting-for-idle" });
    expect(callerSignal?.aborted).toBe(false);
    expect(closed).not.toHaveBeenCalled();
    const otherEntered = deferred<void>();
    const observer = Effect.runFork(
      Effect.promise(async (signal) => {
        const other = jobs.request(f.scope, signal);
        otherEntered.resolve();
        return jobs.wait(other, f.scope, signal);
      }),
    );
    await otherEntered.promise;
    await Effect.runPromise(Fiber.interrupt(observer));
    expect(jobs.status(handle!.jobId, f.scope).state).toBe("waiting-for-idle");
    expect(closed).not.toHaveBeenCalled();
  } finally {
    held.resolve();
    await jobs.close();
    f.consent.close();
    vi.useRealTimers();
  }
  expect(closed).toHaveBeenCalledTimes(1);
});

it("cancelling one interest preserves another, passive status does not start jobs, and late revoked acquisition closes once", async () => {
  const f = await fixture(),
    held = deferred<void>(),
    entered = deferred<void>(),
    closed = vi.fn(async () => {});
  const borrowed = vi.fn(
    async () => ({ close: closed }) as unknown as Awaited<ReturnType<typeof borrowV2SharedService>>,
  );
  const jobs = new V2ActivationJobs(
    f.consent,
    async (job) => {
      entered.resolve();
      await held.promise;
      job.assertCurrent();
    },
    borrowed,
  );
  try {
    expect(() => jobs.status("not-a-job", f.scope)).toThrow("another scope");
    expect(borrowed).not.toHaveBeenCalled();
    const a = jobs.request(f.scope),
      b = jobs.request(f.scope);
    await entered.promise;
    jobs.cancel(a, f.scope);
    expect(closed).not.toHaveBeenCalled();
    held.resolve();
    expect(await jobs.wait(b, f.scope)).toMatchObject({ state: "ready" });
    expect(borrowed).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
  } finally {
    held.resolve();
    await jobs.close();
    f.consent.close();
  }
  const late = await fixture(),
    acquire = deferred<Awaited<ReturnType<typeof borrowV2SharedService>>>(),
    began = deferred<void>(),
    closeLate = vi.fn(async () => {}),
    run = vi.fn(async () => {});
  const revoked = new V2ActivationJobs(late.consent, run, async () => {
    began.resolve();
    return acquire.promise;
  });
  try {
    const handle = revoked.request(late.scope);
    await began.promise;
    revoked.cancel(handle, late.scope);
    acquire.resolve({ close: closeLate } as unknown as Awaited<
      ReturnType<typeof borrowV2SharedService>
    >);
    await revoked.close();
    expect(run).not.toHaveBeenCalled();
    expect(closeLate).toHaveBeenCalledTimes(1);
  } finally {
    await revoked.close();
    late.consent.close();
  }
});
