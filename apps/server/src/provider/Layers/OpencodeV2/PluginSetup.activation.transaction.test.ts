import { readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { makeV2ActivationTransactionFixture } from "./PluginSetup.activation.transaction.fixture.ts";
import { deferred } from "./Test.fixtures.ts";
import { v2ManagedPluginFilename } from "./PluginSetup.record.ts";
import { currentV2RequestContext } from "./Client.guard.ts";
import type { V2ExecutionReservation } from "./PluginSetup.activation.gate.ts";
import { createHash } from "node:crypto";
import { v2Request } from "./Client.ts";

it("busy work in a second owner defers before its detach, preserving already retired phases through same-job retry", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let busy = false;
  const f = await makeV2ActivationTransactionFixture(async () => !busy),
    nextRetire = vi.fn(async () => {});
  f.retire.mockImplementation(async () => {
    f.participants.delete("owned");
    busy = true;
  });
  f.participants.set("next-location", {
    busyCount: () => (busy ? 1 : 0),
    controlCount: () => 0,
    pauseRenewal: () => {},
    resumeRenewal: () => {},
    joinControl: async () => {},
    retire: nextRetire,
  });
  try {
    const handle = f.jobs.request(f.scope),
      result = f.jobs.wait(handle, f.scope);
    await f.waiting.promise;
    expect(nextRetire).not.toHaveBeenCalled();
    expect(f.retire).toHaveBeenCalledTimes(1);
    expect(f.close).not.toHaveBeenCalled();
    expect(() => f.gate.assertOpen()).not.toThrow();
    busy = false;
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toMatchObject({ state: "ready" });
    expect(f.retire).toHaveBeenCalledTimes(1);
    expect(nextRetire).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledTimes(1);
  } finally {
    await f.cleanup();
    vi.useRealTimers();
  }
});

it("a persistent known-busy race cannot extend the original five-minute job deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let calls = 0;
  const f = await makeV2ActivationTransactionFixture(async () => ++calls % 2 === 1);
  try {
    const handle = f.jobs.request(f.scope);
    await f.waiting.promise;
    await vi.advanceTimersByTimeAsync(300000);
    expect(await f.jobs.wait(handle, f.scope)).toMatchObject({ state: "cancelled" });
    expect(f.retire).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(() => f.gate.assertOpen()).not.toThrow();
  } finally {
    await f.cleanup();
    vi.useRealTimers();
  }
});

const writes = vi.hoisted(() => ({ count: 0 }));
vi.mock("./PluginSetup.native.ts", async () => {
  const { publishV2ManagedPlugin } = await import("./PluginSetup.publication.ts");
  return {
    makeV2AutomaticPluginSetup:
      (settings: any, _consent: any, publication: any) =>
      async (artifact: any, _client: any, _directory: any, signal: AbortSignal) => {
        await publishV2ManagedPlugin(
          artifact,
          settings.currentSnapshot().settings.providers.opencodeV2.nativePluginConfigRoot,
          {
            signal,
            assertCurrent: () => currentV2RequestContext()?.permit.assertCurrent(),
            publication,
          },
        );
        writes.count++;
        return artifact;
      },
  };
});

it("a non-cooperative physical cleanup outlives both the RPC timeout and the short gate without dropping the writer lock or job permit", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const entered = deferred<void>(),
    physical = deferred<void>();
  const f = await makeV2ActivationTransactionFixture(async () => true);
  f.retire.mockImplementation(async () => {
    entered.resolve();
    await v2Request("held synthetic cleanup", () => physical.promise);
  });
  writes.count = 0;
  try {
    const handle = f.jobs.request(f.scope);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(30000);
    expect(() => f.gate.assertOpen()).not.toThrow();
    expect(f.jobs.status(handle.jobId, f.scope).state).toBe("uncertain");
    expect(f.close).not.toHaveBeenCalled();
    const lock = path.join(
      f.app.artifact.root,
      "activation-locks",
      createHash("sha256").update(f.root).digest("hex"),
      `.bigbud-thread-tools-${f.app.artifact.issuer}.lock`,
    );
    expect((await lstat(lock)).isFile()).toBe(true);
    expect(f.jobs.isSettled(handle.jobId)).toBe(false);
    expect(writes.count).toBe(0);
    physical.resolve();
    const status = await f.jobs.wait(handle, f.scope);
    expect(status.state).toBe("uncertain");
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(writes.count).toBe(0);
  } finally {
    physical.resolve();
    await f.cleanup();
    vi.useRealTimers();
  }
});
vi.mock("./Orchestration.readiness.ts", () => ({
  verifyV2ThreadTools: async (artifact: any) => ({
    bootstrapDigest: artifact.artifactDigest,
    setupInstanceId: "a".repeat(32),
  }),
}));

it("the short gate releases at 15 seconds while a non-cooperative final observation keeps physical/job ownership", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const held = deferred<boolean>(),
    entered = deferred<void>();
  let calls = 0;
  const f = await makeV2ActivationTransactionFixture(async () => {
    if (++calls === 1) return true;
    entered.resolve();
    return held.promise;
  });
  writes.count = 0;
  try {
    const handle = f.jobs.request(f.scope);
    await entered.promise;
    expect(() => f.gate.assertOpen()).toThrow("closed");
    await vi.advanceTimersByTimeAsync(15000);
    expect(() => f.gate.assertOpen()).not.toThrow();
    expect(f.close).not.toHaveBeenCalled();
    expect(f.retire).not.toHaveBeenCalled();
    expect(writes.count).toBe(0);
    held.resolve(true);
    await f.jobs.wait(handle, f.scope);
    expect(f.retire).not.toHaveBeenCalled();
    expect(writes.count).toBe(0);
    await expect(
      lstat(path.join(f.root, "plugins", v2ManagedPluginFilename(f.app.artifact))),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    held.resolve(true);
    await f.cleanup();
    vi.useRealTimers();
  }
});

it.each(["local-reservation", "after-join", "before-publication"] as const)(
  "known busy %s is deferred inside the same job and later publishes exactly once",
  async (scenario) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let calls = 0,
      token: V2ExecutionReservation | undefined;
    const f = await makeV2ActivationTransactionFixture(async () => {
      calls++;
      if (scenario === "local-reservation" && calls === 1)
        token = f.gate.tryReserve(
          f.gate.verify(f.root, f.scope.digest, "old-ready"),
          "competing-start",
        );
      if (scenario === "after-join" && calls === 2) return false;
      if (scenario === "before-publication" && calls === 4) return false;
      return true;
    });
    writes.count = 0;
    try {
      const handle = f.jobs.request(f.scope),
        result = f.jobs.wait(handle, f.scope);
      const first = await Promise.race([
        result.then((state) => state.state),
        f.waiting.promise.then(() => "waiting-for-idle"),
      ]);
      expect(first).toBe("waiting-for-idle");
      expect(f.close).not.toHaveBeenCalled();
      expect(() => f.gate.assertOpen()).not.toThrow();
      expect(writes.count).toBe(0);
      if (scenario !== "before-publication") expect(f.retire).not.toHaveBeenCalled();
      if (token) f.gate.cancelUndispatched(token);
      await vi.advanceTimersByTimeAsync(2000);
      expect(await result).toMatchObject({ state: "ready" });
      expect(writes.count).toBe(1);
      expect(
        await readFile(
          path.join(f.root, "plugins", v2ManagedPluginFilename(f.app.artifact)),
          "utf8",
        ),
      ).toContain(f.app.artifact.entryUri);
      expect(f.close).toHaveBeenCalledTimes(1);
    } finally {
      if (token) f.gate.cancelUndispatched(token);
      await f.cleanup();
      vi.useRealTimers();
    }
  },
);
