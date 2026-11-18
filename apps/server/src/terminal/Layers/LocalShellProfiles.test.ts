import type { TerminalShellProfile } from "@bigbud/contracts/workspace/terminalShell.ts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vitest";
import { LocalShellDiscoveryError } from "../Services/LocalShellProfiles";
import { makeLocalShellProfiles, MAX_LOCAL_SHELL_PROFILES } from "./LocalShellProfiles";

const profile: TerminalShellProfile = {
  profileId: "test-shell",
  host: { kind: "local", hostId: "local" },
  kind: "bash",
  displayName: "Bash",
  executable: "/bin/bash",
  args: [],
  platform: "linux",
  availability: "available",
  integration: { status: "unavailable", reason: "not-qualified" },
};

describe("local shell profile inventory", () => {
  it("caches successful probes for five minutes and supports explicit refresh", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        let probes = 0;
        const service = yield* makeLocalShellProfiles(
          Effect.sync(() => {
            probes += 1;
            return [profile];
          }),
        );
        yield* service.list;
        yield* TestClock.adjust("299 seconds");
        yield* service.list;
        expect(probes).toBe(1);
        yield* TestClock.adjust("1 second");
        yield* service.list;
        expect(probes).toBe(2);
        yield* service.invalidate;
        yield* service.list;
        expect(probes).toBe(3);
      }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
    );
  });

  it("coalesces concurrent display probes", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let probes = 0;
        const service = yield* makeLocalShellProfiles(
          Effect.gen(function* () {
            probes += 1;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return [profile];
          }),
        );
        const first = yield* Effect.forkChild(service.list);
        yield* Deferred.await(entered);
        const second = yield* Effect.forkChild(service.list);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(first)).toEqual([profile]);
        expect(yield* Fiber.join(second)).toEqual([profile]);
        expect(probes).toBe(1);
      }),
    );
  });

  it("does not cache failed discovery as a successful empty inventory", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        let probes = 0;
        const service = yield* makeLocalShellProfiles(
          Effect.suspend(() => {
            probes += 1;
            return probes === 1
              ? Effect.fail(new LocalShellDiscoveryError({ reason: "timed-out" }))
              : Effect.succeed([]);
          }),
        );
        expect((yield* Effect.result(service.list))._tag).toBe("Failure");
        expect(yield* service.list).toEqual([]);
        expect(probes).toBe(2);
      }),
    );
  });

  it("always revalidates launch inventory rather than trusting a display snapshot", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        let inventory: readonly TerminalShellProfile[] = [profile];
        const service = yield* makeLocalShellProfiles(Effect.sync(() => inventory));
        expect(yield* service.list).toEqual([profile]);
        inventory = [];
        expect(yield* service.revalidate).toEqual([]);
        expect(yield* service.list).toEqual([]);
        inventory = [profile];
        expect(yield* service.revalidate).toEqual([profile]);
      }),
    );
  });

  it("invalidates a stale display snapshot after a failed launch probe", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        let fail = false;
        let probes = 0;
        const service = yield* makeLocalShellProfiles(
          Effect.suspend(() => {
            probes += 1;
            return fail
              ? Effect.fail(new LocalShellDiscoveryError({ reason: "probe-failed" }))
              : Effect.succeed([profile]);
          }),
        );
        yield* service.list;
        fail = true;
        yield* Effect.result(service.revalidate);
        fail = false;
        yield* service.list;
        expect(probes).toBe(3);
      }),
    );
  });

  it("rejects oversized or nonlocal inventories instead of substituting hosts", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        for (const inventory of [
          Array.from({ length: MAX_LOCAL_SHELL_PROFILES + 1 }, () => profile),
          [{ ...profile, host: { kind: "ssh", hostId: "remote" } } as const],
          [{ ...profile, host: { kind: "local", hostId: "other" } } as const],
        ]) {
          const service = yield* makeLocalShellProfiles(Effect.succeed(inventory));
          const failure = yield* Effect.flip(service.list);
          expect(failure.reason).toBe("probe-failed");
        }
      }),
    );
  });

  it("settles a cancelled probe and allows a later caller to retry", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        let probes = 0;
        const service = yield* makeLocalShellProfiles(
          Effect.gen(function* () {
            probes += 1;
            if (probes > 1) return [profile];
            yield* Deferred.succeed(entered, undefined);
            return yield* Effect.never;
          }),
        );
        const cancelled = yield* Effect.forkChild(service.list);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(cancelled);
        expect(yield* service.list.pipe(Effect.timeout("1 second"))).toEqual([profile]);
        expect(probes).toBe(2);
      }),
    );
  });

  it("does not let an invalidated in-flight probe repopulate the display cache", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let probes = 0;
        const service = yield* makeLocalShellProfiles(
          Effect.gen(function* () {
            probes += 1;
            if (probes > 1) return [];
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return [profile];
          }),
        );
        const stale = yield* Effect.forkChild(service.list);
        yield* Deferred.await(entered);
        yield* service.invalidate;
        expect(yield* service.list).toEqual([]);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(stale);
        expect(yield* service.list).toEqual([]);
        expect(probes).toBe(2);
      }),
    );
  });
});
