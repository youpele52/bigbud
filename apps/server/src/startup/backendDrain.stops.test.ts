import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vitest";

import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import type { LegacyDrainPane } from "../ssh/sshLegacyDrain.ts";
import {
  recordVerifiedSshMonitorTarget,
  sshMonitorLease,
  stopAllSshMonitorTargets,
} from "../ssh/sshMonitor.connections.ts";
import { makeLiveBackendDrainHandler, stopProviderSessions } from "./backendDrain.live.ts";
import type { BackendDrainRequest } from "./backendDrain.protocol.ts";
import { decideBackendDrain, subscribeBackendDrainConsent } from "./backendDrain.consent.ts";
import { registerBackendDrainStop, runBackendDrainStopStep } from "./backendDrain.stops.ts";

const TARGET = "ssh:host=drain-stop-test&auth=ssh-key";

const request: BackendDrainRequest = {
  v: 1,
  token: "a".repeat(64),
  method: "drain",
  artifactId: "build-a",
  consent: "non-interactive",
  waitMs: 5_000,
};

const directPane: LegacyDrainPane = {
  paneId: "thread-1:terminal-1",
  threadId: "thread-1",
  threadTitle: "Thread 1",
  title: "Terminal 1",
  surface: "direct-ssh",
  leaseId: "thread-1:terminal-1",
  keepMode: false,
};

/** A live provider service fake: sessions stay listed until their stop runs. */
function fakeProviders(events: string[]) {
  const sessions = new Set(["thread-a", "thread-b"]);
  const service = {
    listSessions: () => Effect.sync(() => [...sessions].map((threadId) => ({ threadId }) as never)),
    stopSession: ({ threadId }: { threadId: string }) =>
      Effect.sync(() => {
        sessions.delete(threadId);
        events.push(`provider:${threadId}`);
      }),
  } as unknown as ProviderServiceShape;
  return { service, sessions };
}

/** A live relay owner fake: open leases close through the registered drain stop. */
function fakeRelays(events: string[], count: number) {
  const open = new Set(Array.from({ length: count }, (_, index) => `relay-${index}`));
  const closeAll = async () => {
    const closed = open.size;
    for (const id of open) events.push(`relay:${id}`);
    open.clear();
    return closed;
  };
  return { open, closeAll };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  stopAllSshMonitorTargets();
});

function liveDeps(events: string[], committed: string[]) {
  return {
    profileScope: "backend",
    artifactId: "build-a",
    listPanes: () => Effect.succeed([directPane]),
    closePane: (pane: LegacyDrainPane) => Effect.sync(() => events.push(`close:${pane.paneId}`)),
    stopMonitors: runBackendDrainStopStep("monitors", 1_000),
    stopRelays: runBackendDrainStopStep("relays", 200),
    stopProviders: runBackendDrainStopStep("providers", 1_000),
    closeOwnedMasters: Effect.sync(() => {
      events.push("masters");
      return { closed: 1, failed: 0 };
    }),
    commit: () => Effect.sync(() => void committed.push("marker")),
    releaseLock: Effect.sync(() => void events.push("release")),
  };
}

describe("backend drain real stop phase", () => {
  it("stops live monitors, relays and providers before any pane closes and reports them", async () => {
    const events: string[] = [];
    const committed: string[] = [];
    recordVerifiedSshMonitorTarget(TARGET, "instance:1");
    recordVerifiedSshMonitorTarget(TARGET, "instance:2");
    const relays = fakeRelays(events, 2);
    const providers = fakeProviders(events);
    cleanups.push(
      registerBackendDrainStop("monitors", async () => {
        const stopped = stopAllSshMonitorTargets();
        events.push(`monitors:${stopped}`);
        return stopped;
      }),
      registerBackendDrainStop("relays", relays.closeAll),
      registerBackendDrainStop("providers", () =>
        Effect.runPromise(stopProviderSessions(providers.service)),
      ),
    );

    const response = await makeLiveBackendDrainHandler(liveDeps(events, committed))(request);

    expect(response).toEqual({
      v: 1,
      ok: true,
      status: "drained",
      stops: [
        { step: "monitors", stopped: 1, owners: 1 },
        { step: "relays", stopped: 2, owners: 1 },
        { step: "providers", stopped: 2, owners: 1 },
      ],
      owner: { masters: 1, leases: 0 },
    });
    expect(events).toEqual([
      "monitors:1",
      "relay:relay-0",
      "relay:relay-1",
      "provider:thread-a",
      "provider:thread-b",
      "close:thread-1:terminal-1",
      "masters",
      "release",
    ]);
    expect(sshMonitorLease(TARGET, "instance:1")).toBeNull();
    expect(relays.open.size).toBe(0);
    expect(providers.sessions.size).toBe(0);
    expect(committed).toEqual(["marker"]);
  });

  it("a relay stop that misses its deadline fails the drain before any close or marker", async () => {
    const events: string[] = [];
    const committed: string[] = [];
    const providers = fakeProviders(events);
    cleanups.push(
      registerBackendDrainStop("relays", () => new Promise<number>(() => {})),
      registerBackendDrainStop("providers", () =>
        Effect.runPromise(stopProviderSessions(providers.service)),
      ),
    );

    const response = await makeLiveBackendDrainHandler(liveDeps(events, committed))(request);

    expect(response).toMatchObject({ ok: false, error: { code: "failed" } });
    expect(events).toEqual([]);
    expect(providers.sessions.size).toBe(2);
    expect(committed).toEqual([]);
  });

  it("UI Cancel stops no monitor, relay or provider and closes nothing", async () => {
    const events: string[] = [];
    const committed: string[] = [];
    recordVerifiedSshMonitorTarget(TARGET, "instance:1");
    const relays = fakeRelays(events, 1);
    const providers = fakeProviders(events);
    cleanups.push(
      registerBackendDrainStop("monitors", async () => stopAllSshMonitorTargets()),
      registerBackendDrainStop("relays", relays.closeAll),
      registerBackendDrainStop("providers", () =>
        Effect.runPromise(stopProviderSessions(providers.service)),
      ),
      subscribeBackendDrainConsent((pending) => {
        if (pending) decideBackendDrain(pending.drainId, { kind: "cancel" });
      }),
    );

    const response = await makeLiveBackendDrainHandler(liveDeps(events, committed))({
      ...request,
      consent: "ui",
    });

    expect(response).toEqual({ v: 1, ok: true, status: "cancelled" });
    expect(events).toEqual([]);
    expect(sshMonitorLease(TARGET, "instance:1")).not.toBeNull();
    expect(relays.open.size).toBe(1);
    expect(providers.sessions.size).toBe(2);
    expect(committed).toEqual([]);
  });
});
