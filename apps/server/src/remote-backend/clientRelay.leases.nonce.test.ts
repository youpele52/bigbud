import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { makeLeaseFixture, fetchLease } from "./clientRelay.leases.test.helpers.ts";
import { makeRemoteBackendRelayLeases } from "./clientRelay.leases.ts";
import { openRemoteBackendRelayProfileOwner } from "./clientRelay.profileOwner.ts";
import type { RemoteBackendRelayOwnedEndpoint } from "./clientRelay.profileOwner.ts";
import type { ResolvedRemoteBackendRelayProfile } from "./clientRelay.profiles.ts";
const calls = vi.hoisted(() => ({
  children: [] as import("node:child_process").ChildProcess[],
  args: [] as string[],
}));
vi.mock("../ssh/sshVerification.ts", () => ({
  assertSshExecutionTargetReadyAsync: async () => {},
}));
vi.mock("../ssh/sshHostTrust.ts", () => ({ inspectSshHostTrust: async () => {} }));
vi.mock("../ssh/sshCommand.ts", () => ({
  buildSshCommandInvocation: () => ({ command: process.execPath, args: calls.args }),
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      calls.children.push(child);
      return child;
    },
  };
});
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
  vi.unstubAllEnvs();
});
beforeEach(() => {
  calls.children = [];
});
const fixture = () => makeLeaseFixture(calls, cleanup);
it("lost open reply retry reuses one endpoint and real child; conflicting nonce payload refuses", async () => {
  const f = await fixture(),
    nonce = randomUUID(),
    signal = new AbortController().signal;
  const lostReply = await f.leases.open("route:1", f.profile.profile.profileId, signal, nonce);
  const retried = await f.leases.open("route:1", f.profile.profile.profileId, signal, nonce);
  expect(retried).toEqual(lostReply);
  expect(await fetchLease(retried)).toBe("lease-output");
  expect(calls.children).toHaveLength(1);
  await expect(f.leases.open("route:1", "different-profile", signal, nonce)).rejects.toMatchObject({
    code: "conflict",
  });
  expect(calls.children).toHaveLength(1);
  await f.leases.cancel("route:1", nonce);
  expect(calls.children[0]!.exitCode !== null || calls.children[0]!.signalCode !== null).toBe(true);
  await expect(
    f.leases.open("route:1", f.profile.profile.profileId, signal, nonce),
  ).rejects.toMatchObject({ code: "caller-closed" });
});
it("cancel by known request nonce fences both a delayed lookup and an open arriving later", async () => {
  const f = await fixture(),
    nonce = randomUUID(),
    signal = new AbortController().signal;
  let release!: (profile: ResolvedRemoteBackendRelayProfile) => void,
    observed!: () => void,
    opens = 0;
  const received = new Promise<void>((done) => {
    observed = done;
  });
  const leases = makeRemoteBackendRelayLeases({
    profiles: {
      list: async () => ({ availability: "available", profiles: [] }),
      resolve: () => {
        observed();
        return new Promise((done) => {
          release = done;
        });
      },
    },
    isCallerActive: async () => true,
    openProfile: async (profile, ownedSignal) => {
      opens++;
      return openRemoteBackendRelayProfileOwner(profile, [], ownedSignal);
    },
  });
  cleanup.push(leases.dispose);
  const opening = leases.open("route:1", f.profile.profile.profileId, signal, nonce),
    failed = expect(opening).rejects.toMatchObject({ code: "caller-closed" });
  await received;
  const canceled = leases.cancel("route:1", nonce);
  release(f.profile);
  await canceled;
  await failed;
  expect(opens).toBe(0);
  const beforeOpen = randomUUID();
  expect(await leases.cancel("route:1", beforeOpen)).toEqual({ closed: true });
  await expect(
    leases.open("route:1", f.profile.profile.profileId, signal, beforeOpen),
  ).rejects.toMatchObject({ code: "caller-closed" });
});
it("pending creator cancellation waits for its real child and late owner settlement", async () => {
  const f = await fixture(),
    nonce = randomUUID();
  let produced!: (owner: RemoteBackendRelayOwnedEndpoint) => void, release!: () => void;
  const created = new Promise<RemoteBackendRelayOwnedEndpoint>((done) => {
    produced = done;
  });
  const held = new Promise<void>((done) => {
    release = done;
  });
  const leases = makeRemoteBackendRelayLeases({
    profiles: {
      list: async () => ({ availability: "available", profiles: [] }),
      resolve: async () => f.profile,
    },
    isCallerActive: async () => true,
    openProfile: async (profile, signal) => {
      const owner = await openRemoteBackendRelayProfileOwner(profile, [], signal);
      produced(owner);
      await held;
      return owner;
    },
  });
  cleanup.push(leases.dispose);
  const opening = leases.open(
      "route:1",
      f.profile.profile.profileId,
      new AbortController().signal,
      nonce,
    ),
    failed = expect(opening).rejects.toMatchObject({ code: "caller-closed" });
  const owner = await created;
  expect(await fetchLease(owner)).toBe("lease-output");
  const childClosed = once(calls.children[0]!, "close");
  let settled = false;
  const canceled = leases.cancel("route:1", nonce).then(() => {
    settled = true;
  });
  await childClosed;
  expect(settled).toBe(false);
  release();
  await canceled;
  await failed;
  await expect(fetchLease(owner)).rejects.toThrow();
});
it("bounded canceled history refuses new nonces instead of evicting a replay fence", async () => {
  const f = await fixture(),
    signal = new AbortController().signal;
  const leases = makeRemoteBackendRelayLeases({
    maxCallerHistory: 2,
    profiles: {
      list: async () => ({ availability: "available", profiles: [] }),
      resolve: async () => f.profile,
    },
    isCallerActive: async (caller) => f.active.has(caller),
    openProfile: (profile, ownedSignal) =>
      openRemoteBackendRelayProfileOwner(profile, [], ownedSignal),
  });
  cleanup.push(leases.dispose);
  const first = randomUUID(),
    second = randomUUID();
  await leases.cancel("route:1", first);
  await leases.cancel("route:1", second);
  await expect(
    leases.open("route:1", f.profile.profile.profileId, signal, randomUUID()),
  ).rejects.toMatchObject({ code: "limit" });
  await expect(
    leases.open("route:1", f.profile.profile.profileId, signal, first),
  ).rejects.toMatchObject({ code: "caller-closed" });
  const other = await leases.open("route:2", f.profile.profile.profileId, signal, first);
  expect(await fetchLease(other)).toBe("lease-output");
  f.active.delete("route:1");
  await leases.closeCaller("route:1");
  await expect(
    leases.open("route:1", f.profile.profile.profileId, signal, first),
  ).rejects.toMatchObject({ code: "caller-closed" });
});
it("a stale active-client read cannot enter profile lookup after authoritative disconnect", async () => {
  const f = await fixture();
  let checked!: () => void,
    release!: (value: boolean) => void,
    reads = 0,
    lookups = 0;
  const observed = new Promise<void>((done) => {
    checked = done;
  });
  const stale = new Promise<boolean>((done) => {
    release = done;
  });
  const leases = makeRemoteBackendRelayLeases({
    profiles: {
      list: async () => ({ availability: "available", profiles: [] }),
      resolve: async () => {
        lookups++;
        return f.profile;
      },
    },
    isCallerActive: async () => {
      if (++reads === 1) {
        checked();
        return stale;
      }
      return false;
    },
    openProfile: (profile, signal) => openRemoteBackendRelayProfileOwner(profile, [], signal),
  });
  cleanup.push(leases.dispose);
  const opening = leases.open(
    "route:1",
    f.profile.profile.profileId,
    new AbortController().signal,
    randomUUID(),
  );
  const rejected = expect(opening).rejects.toMatchObject({ code: "caller-closed" });
  await observed;
  const closed = leases.closeCaller("route:1");
  release(true);
  await closed;
  await rejected;
  expect(lookups).toBe(0);
  expect(calls.children).toHaveLength(0);
});
