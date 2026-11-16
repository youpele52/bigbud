import { makeLeaseFixture, fetchLease } from "./clientRelay.leases.test.helpers.ts";
import { randomUUID } from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Queue from "effect/Queue";
import { bridgeSshMonitorDisconnects } from "../ws/wsSshMonitor.protocol.ts";
import { buildTestServerConfig } from "../server.test.app.config.ts";
import { ServerConfig } from "../startup/config.ts";
import { makeRemoteBackendRelayRoute } from "./clientRelay.route.ts";
import { RemoteBackendRelayProfiles } from "./clientRelay.profiles.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { makeRemoteBackendRelayLeases } from "./clientRelay.leases.ts";
import { openRemoteBackendRelayProfileOwner } from "./clientRelay.profileOwner.ts";
import {
  unavailableRemoteBackendRelayProfiles,
  type ResolvedRemoteBackendRelayProfile,
} from "./clientRelay.profiles.ts";
import { makeWsRpcRemoteBackendRelayHandlers } from "../ws/wsRpcHandlers.remoteBackendRelay.ts";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
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

it("explicit production default reports setup-required and never creates a listener", async () => {
  let opens = 0;
  const leases = makeRemoteBackendRelayLeases({
    profiles: unavailableRemoteBackendRelayProfiles,
    isCallerActive: async () => true,
    openProfile: async () => {
      opens++;
      throw new Error("Unexpected activation");
    },
  });
  expect(await leases.list("route:1", new AbortController().signal)).toEqual({
    availability: "setup-required",
    profiles: [],
  });
  await expect(
    leases.open("route:1", "missing-profile", new AbortController().signal),
  ).rejects.toMatchObject({ code: "setup-required" });
  expect(opens).toBe(0);
  await leases.dispose();
});
it("caller close awaits real transport child exit and preserves another caller's endpoint", async () => {
  const f = await fixture(),
    signal = new AbortController().signal;
  const first = await f.leases.open("route:1", f.profile.profile.profileId, signal),
    second = await f.leases.open("route:2", f.profile.profile.profileId, signal);
  expect(first.localCredential).not.toBe(second.localCredential);
  expect(await fetchLease(first)).toBe("lease-output");
  expect(await fetchLease(second)).toBe("lease-output");
  expect(calls.children).toHaveLength(2);
  expect(await f.leases.close("route:2", first.leaseId)).toEqual({ closed: false });
  await f.leases.close("route:1", first.leaseId);
  expect(await f.leases.close("route:1", first.leaseId)).toEqual({ closed: false });
  expect(calls.children[0]!.exitCode !== null || calls.children[0]!.signalCode !== null).toBe(true);
  await expect(fetchLease(first)).rejects.toThrow();
  expect(await fetchLease(second)).toBe("lease-output");
  f.active.delete("route:2");
  await f.leases.closeCaller("route:2");
  expect(calls.children[1]!.exitCode !== null || calls.children[1]!.signalCode !== null).toBe(true);
  await expect(fetchLease(second)).rejects.toThrow();
});
it("disconnect during private profile lookup prevents late listener creation", async () => {
  let resolve!: (profile: ResolvedRemoteBackendRelayProfile) => void,
    active = true,
    opens = 0;
  const f = await fixture();
  let observed!: () => void;
  const received = new Promise<void>((done) => {
    observed = done;
  });
  const leases = makeRemoteBackendRelayLeases({
    profiles: {
      list: async () => ({ availability: "available", profiles: [] }),
      resolve: () =>
        new Promise((done) => {
          resolve = done;
          observed();
        }),
    },
    isCallerActive: async () => active,
    openProfile: async (profile, signal) => {
      opens++;
      return openRemoteBackendRelayProfileOwner(profile, [], signal);
    },
  });
  cleanup.push(leases.dispose);
  const opening = leases.open("route:1", f.profile.profile.profileId, new AbortController().signal);
  const rejected = expect(opening).rejects.toMatchObject({ code: "caller-closed" });
  await received;
  active = false;
  const closing = leases.closeCaller("route:1");
  resolve(f.profile);
  await closing;
  await rejected;
  expect(opens).toBe(0);
});
it("RPC metadata is required and remote-mode handler cannot use local relay privileges", async () => {
  const f = await fixture();
  const local = makeWsRpcRemoteBackendRelayHandlers({
    leases: f.leases,
    instanceId: "route",
    local: true,
  });
  await expect(
    Effect.runPromise(
      local[WS_METHODS.serverOpenRemoteBackendRelay]({
        profileId: f.profile.profile.profileId,
        requestId: randomUUID(),
      }),
    ),
  ).rejects.toMatchObject({ code: "caller-closed" });
  const remote = makeWsRpcRemoteBackendRelayHandlers({
    leases: f.leases,
    instanceId: "route",
    local: false,
  });
  await expect(
    Effect.runPromise(
      remote[WS_METHODS.serverOpenRemoteBackendRelay](
        { profileId: f.profile.profile.profileId, requestId: randomUUID() },
        { clientId: 1 },
      ),
    ),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(calls.children).toHaveLength(0);
});

it("authoritative disconnect forwards only after the real channel child is closed", async () => {
  const f = await fixture();
  const lease = await f.leases.open(
    "route:1",
    f.profile.profile.profileId,
    new AbortController().signal,
  );
  expect(await fetchLease(lease)).toBe("lease-output");
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const source = yield* Queue.unbounded<number>();
        const forwarded = yield* bridgeSshMonitorDisconnects(source, "route", (id) =>
          f.leases.closeCaller(`route:${id}`),
        );
        f.active.delete("route:1");
        yield* Queue.offer(source, 1);
        expect(yield* Queue.take(forwarded)).toBe(1);
        expect(calls.children[0]!.exitCode !== null || calls.children[0]!.signalCode !== null).toBe(
          true,
        );
      }),
    ),
  );
  await expect(fetchLease(lease)).rejects.toThrow();
});
it("HTTP server Scope retains a returned lease and awaits real process cleanup at shutdown", async () => {
  const f = await fixture();
  let retained: { baseUrl: string; localCredential: string } | undefined;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* buildTestServerConfig({
          config: { mode: "desktop", authToken: "local-control-fixture" },
        });
        const scope = yield* Effect.scope;
        const route = yield* makeRemoteBackendRelayRoute("route", scope).pipe(
          Effect.provideService(ServerConfig, config),
          Effect.provideService(RemoteBackendRelayProfiles, {
            list: async () => ({ availability: "available", profiles: [f.profile.profile] }),
            resolve: async () => f.profile,
          }),
        );
        route.lifecycle.ready(async () => new Set([1]));
        retained = yield* route.handlers[WS_METHODS.serverOpenRemoteBackendRelay](
          { profileId: f.profile.profile.profileId, requestId: randomUUID() },
          { clientId: 1 },
        );
        expect(yield* Effect.promise(() => fetchLease(retained!))).toBe("lease-output");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
  expect(calls.children[0]!.exitCode !== null || calls.children[0]!.signalCode !== null).toBe(true);
  await expect(fetchLease(retained!)).rejects.toThrow();
});
it("listing projects only explicit public pin fields and respects per-caller capacity", async () => {
  const f = await fixture();
  Object.assign(f.profile.profile, { deployment: f.profile.deployment });
  Object.assign(f.profile.profile.identity.authority, { privateKey: "fixture-private-value" });
  const listed = await f.leases.list("route:1", new AbortController().signal);
  expect(JSON.stringify(listed)).not.toContain("deployment");
  expect(JSON.stringify(listed)).not.toContain("fixture-private-value");
  const opened = [];
  for (let index = 0; index < 4; index++)
    opened.push(
      await f.leases.open("route:1", f.profile.profile.profileId, new AbortController().signal),
    );
  await expect(
    f.leases.open("route:1", f.profile.profile.profileId, new AbortController().signal),
  ).rejects.toMatchObject({ code: "limit" });
  await f.leases.close("route:1", opened[0]!.leaseId);
  expect(
    await f.leases.open("route:1", f.profile.profile.profileId, new AbortController().signal),
  ).toHaveProperty("localCredential");
});
it("authless local configuration cannot activate even an injected approved profile", async () => {
  const f = await fixture();
  let lookups = 0;
  const denied = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* buildTestServerConfig({ config: { mode: "web" } });
        const scope = yield* Effect.scope;
        const route = yield* makeRemoteBackendRelayRoute("route", scope).pipe(
          Effect.provideService(ServerConfig, config),
          Effect.provideService(RemoteBackendRelayProfiles, {
            list: async () => ({ availability: "available", profiles: [f.profile.profile] }),
            resolve: async () => {
              lookups++;
              return f.profile;
            },
          }),
        );
        route.lifecycle.ready(async () => new Set([1]));
        return yield* route.handlers[WS_METHODS.serverOpenRemoteBackendRelay](
          { profileId: f.profile.profile.profileId, requestId: randomUUID() },
          { clientId: 1 },
        ).pipe(
          Effect.match({
            onSuccess: () => false,
            onFailure: (error) => error.code === "unavailable",
          }),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
  expect(denied).toBe(true);
  expect(lookups).toBe(0);
  expect(calls.children).toHaveLength(0);
});
