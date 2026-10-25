import { expect, it, vi } from "vitest";
import { V2ActivationJobs, type V2OwnedActivationJob } from "./PluginSetup.activation.jobs.ts";
import { makeV2ActivationJobsFixture } from "./PluginSetup.activation.jobs.fixture.ts";
import type { borrowV2SharedService } from "./SharedService.connection.ts";
import { deferred } from "./Test.fixtures.ts";

type Connection = Awaited<ReturnType<typeof borrowV2SharedService>>;

it("a late join cannot extend the creation deadline or publish after expiry; physical close retains writer ownership", async () => {
  vi.useFakeTimers();
  const f = await makeV2ActivationJobsFixture(),
    entered = deferred<V2OwnedActivationJob>(),
    aborted = deferred<void>(),
    finish = deferred<void>(),
    closing = deferred<void>(),
    closePhysical = deferred<void>();
  const close = vi.fn(async () => {
    closing.resolve();
    await closePhysical.promise;
  });
  const jobs = new V2ActivationJobs(
    f.consent,
    async (job) => {
      job.phase("waiting-for-idle");
      job.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      entered.resolve(job);
      await finish.promise;
      job.assertCurrent();
    },
    async () => ({ close }) as unknown as Connection,
  );
  try {
    const first = jobs.request(f.scope),
      owned = await entered.promise,
      deadline = owned.deadline;
    const foreground = jobs.wait(first, f.scope);
    await vi.advanceTimersByTimeAsync(30000);
    expect(await foreground).toMatchObject({ state: "waiting-for-idle" });
    await vi.advanceTimersByTimeAsync(269000);
    const last = jobs.request(f.scope);
    expect(last.jobId).toBe(first.jobId);
    expect(owned.deadline).toBe(deadline);
    await vi.advanceTimersByTimeAsync(1000);
    await aborted.promise;
    expect(owned.signal.aborted).toBe(true);
    expect(() => owned.phase("publishing")).toThrow();
    expect(close).not.toHaveBeenCalled();
    finish.resolve();
    await closing.promise;
    expect(jobs.status(first.jobId, f.scope).state).toBe("cancelled");
    expect(jobs.isSettled(first.jobId)).toBe(false);
    expect(() => jobs.request({ ...f.scope, digest: "c".repeat(64) })).toThrow(
      "physical writer remains owned",
    );
    closePhysical.resolve();
    await jobs.close();
    expect(jobs.isSettled(first.jobId)).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    finish.resolve();
    closePhysical.resolve();
    await jobs.close();
    f.consent.close();
    vi.useRealTimers();
  }
});

it("explicit cancellation removes a transferred continuation but not another interest", async () => {
  vi.useFakeTimers();
  const f = await makeV2ActivationJobsFixture(),
    entered = deferred<V2OwnedActivationJob>(),
    physical = deferred<void>(),
    close = vi.fn(async () => {});
  const jobs = new V2ActivationJobs(
    f.consent,
    async (job) => {
      job.phase("waiting-for-idle");
      entered.resolve(job);
      await physical.promise;
      job.assertCurrent();
    },
    async () => ({ close }) as unknown as Connection,
  );
  try {
    const first = jobs.request(f.scope),
      second = jobs.request(f.scope),
      owned = await entered.promise;
    const foreground = jobs.wait(first, f.scope);
    await vi.advanceTimersByTimeAsync(30000);
    expect(await foreground).toMatchObject({ state: "waiting-for-idle" });
    jobs.cancel(first, f.scope);
    jobs.cancel(first, f.scope);
    expect(owned.signal.aborted).toBe(false);
    await expect(jobs.wait(first, f.scope)).rejects.toThrow("interest is absent");
    jobs.cancel(second, f.scope);
    expect(owned.signal.aborted).toBe(true);
    expect(close).not.toHaveBeenCalled();
    expect(jobs.isSettled(first.jobId)).toBe(false);
    physical.resolve();
    await jobs.close();
    expect(jobs.status(first.jobId, f.scope).state).toBe("cancelled");
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    physical.resolve();
    await jobs.close();
    f.consent.close();
    vi.useRealTimers();
  }
});

it("32 interests and 32 unsettled jobs remain bounded without evicting quarantined writers", async () => {
  const f = await makeV2ActivationJobsFixture(),
    physical = deferred<void>(),
    entered = deferred<void>(),
    close = vi.fn(async () => {});
  let count = 0;
  const jobs = new V2ActivationJobs(
    f.consent,
    async () => {
      if (++count === 32) entered.resolve();
      await physical.promise;
    },
    async () => ({ close }) as unknown as Connection,
  );
  try {
    const interests = Array.from({ length: 32 }, () => jobs.request(f.scope));
    expect(new Set(interests.map((handle) => handle.jobId)).size).toBe(1);
    expect(new Set(interests.map((handle) => handle.interestId)).size).toBe(32);
    expect(() => jobs.request(f.scope)).toThrow("interest capacity");
    const scopes = Array.from({ length: 31 }, (_, index) => ({
      ...f.scope,
      root: `/fixture/root-${index}`,
    }));
    const others = scopes.map((scope) => jobs.request(scope));
    await entered.promise;
    expect(() => jobs.request({ ...f.scope, root: "/fixture/overflow" })).toThrow(
      "job/quarantine capacity",
    );
    for (const handle of interests) jobs.cancel(handle, f.scope);
    for (const [index, handle] of others.entries()) jobs.cancel(handle, scopes[index]!);
    expect(() => jobs.request({ ...f.scope, root: "/fixture/overflow" })).toThrow(
      "job/quarantine capacity",
    );
    expect(close).not.toHaveBeenCalled();
    physical.resolve();
    await jobs.close();
    expect(close).toHaveBeenCalledTimes(32);
  } finally {
    physical.resolve();
    await jobs.close();
    f.consent.close();
  }
});
