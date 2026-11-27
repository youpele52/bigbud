import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import type { SshOwnerProductionRegistration } from "../ssh/sshOwnerProductionRegistry.ts";
import type { BackendDrainRequest } from "./backendDrain.protocol.ts";
import { makeLiveBackendDrainHandler } from "./backendDrain.live.ts";
import { closeSshOwnerForDrain } from "./backendDrain.owner.ts";

const registration = (shutdownForDrain?: () => Promise<unknown>) =>
  ({
    handle: { state: () => "open", ...(shutdownForDrain ? { shutdownForDrain } : {}) },
  }) as unknown as SshOwnerProductionRegistration;

const request: BackendDrainRequest = {
  v: 1,
  token: "a".repeat(64),
  method: "drain",
  artifactId: "build-b",
  consent: "non-interactive",
  waitMs: 5_000,
};

/** W6 defect (a): the drain's owner step shuts the live owner down and reports real counts. */
describe("drain owner step", () => {
  it("shuts the live owner down and reports its masters and leases", async () => {
    let calls = 0;
    const closed = await Effect.runPromise(
      closeSshOwnerForDrain(() =>
        registration(async () => {
          calls += 1;
          return { mastersClosed: 2, leasesClosed: 3, attachCleared: true };
        }),
      ),
    );
    expect(calls).toBe(1);
    expect(closed).toEqual({ closed: 2, failed: 0, leases: 3, attachCleared: true });
  });

  it("reports the shut-down owner's epoch for the B retirement record", async () => {
    const live = {
      handle: {
        state: () => "open",
        ownerEpoch: new Uint8Array([0x0a, 0xff]),
        shutdownForDrain: async () => ({ mastersClosed: 1, leasesClosed: 0, attachCleared: true }),
      },
    } as unknown as SshOwnerProductionRegistration;
    expect(await Effect.runPromise(closeSshOwnerForDrain(() => live))).toEqual({
      closed: 1,
      failed: 0,
      leases: 0,
      attachCleared: true,
      ownerEpoch: "0aff",
    });
  });

  it("has nothing to close without a live owner", async () => {
    expect(await Effect.runPromise(closeSshOwnerForDrain(() => undefined))).toEqual({
      closed: 0,
      failed: 0,
      leases: 0,
    });
  });

  it("fails the drain before the lock release when the owner does not shut down", async () => {
    const events: string[] = [];
    const handler = makeLiveBackendDrainHandler({
      profileScope: "backend",
      artifactId: "build-b",
      listPanes: () => Effect.succeed([]),
      closePane: () => Effect.void,
      stopMonitors: Effect.void,
      stopRelays: Effect.void,
      stopProviders: Effect.void,
      closeOwnedMasters: closeSshOwnerForDrain(() =>
        registration(async () => {
          throw new Error("The SSH owner did not exit within the drain deadline.");
        }),
      ),
      commit: () => Effect.sync(() => void events.push("commit")),
      releaseLock: Effect.sync(() => events.push("release")),
    });
    const response = await handler(request);
    expect(response).toMatchObject({ ok: false, error: { code: "failed" } });
    expect(events).toEqual([]);
  });

  it("reports the owner's counts in the drained response, before the lock release", async () => {
    const events: string[] = [];
    const handler = makeLiveBackendDrainHandler({
      profileScope: "backend",
      artifactId: "build-b",
      listPanes: () => Effect.succeed([]),
      closePane: () => Effect.void,
      stopMonitors: Effect.void,
      stopRelays: Effect.void,
      stopProviders: Effect.void,
      closeOwnedMasters: closeSshOwnerForDrain(() =>
        registration(async () => {
          events.push("owner-shutdown");
          return { mastersClosed: 1, leasesClosed: 4, attachCleared: true };
        }),
      ),
      commit: () => Effect.sync(() => void events.push("commit")),
      releaseLock: Effect.sync(() => events.push("release")),
    });
    const response = await handler(request);
    expect(response).toMatchObject({
      ok: true,
      status: "drained",
      owner: { masters: 1, leases: 4 },
    });
    expect(events).toEqual(["owner-shutdown", "commit", "release"]);
  });
});
