import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import { Deferred, Effect, Fiber, PubSub, Ref, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ProviderRegistration } from "./ProviderRegistration.ts";
import { buildServerProvider } from "./providerSnapshot.ts";
import { managedProviderUsageRefresh } from "./managedProviderUsage.ts";
import { refreshSubscriptionProviders, singleFlightUsageRefresh } from "./providerUsageRefresh.ts";

function snapshot(
  provider: ServerProvider["provider"],
  enabled = true,
  status: Exclude<ServerProvider["status"], "disabled"> = "ready",
) {
  return buildServerProvider({
    provider,
    enabled,
    checkedAt: "2026-10-21T12:00:00.000Z",
    models: [],
    probe: { installed: true, version: "1", status, auth: { status: "authenticated" } },
  });
}

describe("subscription-only refresh", () => {
  it("reads every enabled supported provider, healthy or not, without invoking recovery", async () => {
    const snapshots = [
      snapshot("codex"),
      snapshot("claudeAgent", true, "error"),
      snapshot("cursor"),
      snapshot("opencode"),
      snapshot("devin", false),
      snapshot("copilot"),
    ];
    const reads = snapshots.map(() => vi.fn());
    const recover = vi.fn();
    const registrations: ProviderRegistration[] = snapshots.map((provider, index) => ({
      provider: provider.provider,
      service: {
        getSnapshot: Effect.succeed(provider),
        refresh: Effect.sync(() => {
          recover();
          return provider;
        }),
        refreshWithRecovery: () =>
          Effect.sync(() => {
            recover();
            return provider;
          }),
        streamChanges: Stream.empty,
        ...(provider.provider !== "copilot"
          ? {
              refreshUsageLimits: Effect.sync(() => {
                reads[index]!();
                return provider;
              }),
            }
          : {}),
      },
    }));
    await Effect.runPromise(refreshSubscriptionProviders(registrations, snapshots));
    expect(reads.map((read) => read.mock.calls.length)).toEqual([1, 1, 1, 1, 0, 0]);
    expect(recover).not.toHaveBeenCalled();
  });

  it("coalesces concurrent requests but never caches completed manual reads", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let calls = 0;
        const refresh = singleFlightUsageRefresh(
          Effect.gen(function* () {
            calls++;
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return calls;
          }),
        );
        const first = yield* refresh.pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const second = yield* refresh.pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(first)).toBe(1);
        expect(yield* Fiber.join(second)).toBe(1);
        expect(yield* refresh).toBe(2);
      }),
    );
  });

  it("clears abandoned in-flight work so cancellation cannot strand subsequent refreshes", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        let first = true;
        const refresh = singleFlightUsageRefresh(
          Effect.gen(function* () {
            if (!first) return "fresh";
            first = false;
            yield* Deferred.succeed(started, undefined);
            return yield* Effect.never;
          }),
        );
        const fiber = yield* refresh.pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        expect(yield* refresh).toBe("fresh");
      }),
    );
  });

  it("merges only quota, and discards results when settings change during the read", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const base = snapshot("codex");
        let settings = { enabled: true, home: "account-a" };
        const settingsRef = yield* Ref.make(settings);
        const snapshotRef = yield* Ref.make(base);
        const generationRef = yield* Ref.make(1);
        const changes = yield* PubSub.unbounded<ServerProvider>();
        const limits = {
          source: "codex-app-server" as const,
          status: "available" as const,
          checkedAt: base.checkedAt,
          windows: [],
        };
        const refresh = managedProviderUsageRefresh({
          getSettings: Effect.sync(() => settings),
          settingsRef,
          snapshotRef,
          generationRef,
          changes,
          haveSettingsChanged: (a, b) => a.home !== b.home || a.enabled !== b.enabled,
          read: () => Effect.succeed(limits),
        });
        const next = yield* refresh;
        expect(next).toEqual({ ...base, usageLimits: limits });
        expect(next.models).toBe(base.models);
        const interrupted = managedProviderUsageRefresh({
          getSettings: Effect.sync(() => settings),
          settingsRef,
          snapshotRef,
          generationRef,
          changes,
          haveSettingsChanged: (a, b) => a.home !== b.home,
          read: () =>
            Effect.sync(() => {
              settings = { enabled: true, home: "account-b" };
              return { ...limits, status: "error" as const };
            }),
        });
        expect(yield* interrupted).toBe(next);
        expect(yield* Ref.get(snapshotRef)).toBe(next);
        yield* PubSub.shutdown(changes);
      }),
    );
  });
});
