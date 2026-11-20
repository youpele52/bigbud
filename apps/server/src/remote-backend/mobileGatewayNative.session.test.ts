import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { afterEach, expect, it, vi } from "vitest";
import {
  connectNativeServiceLeaseClient,
  type NativeServiceLeaseClient,
} from "../remote-agent/remoteAgentServiceLeaseClient.ts";
import { exitedReply } from "../remote-agent/remoteAgentServiceLease.successor.fixture.ts";
import { successorFixture } from "../remote-agent/remoteAgentServiceLease.successor.fixture.ts";
import type { VerifiedMobilePublication } from "../remote-agent/mobileOptionalPublication.ts";
import { stateDir } from "../remote-agent/remoteAgentServiceLease.test.fixture.ts";
import { RemoteAgentRuntimeOwners } from "../persistence/Layers/RemoteAgentRuntimeBindings.service.ts";
import { BackendInstance } from "../startup/backendInstance.ts";
import { ServerConfig } from "../startup/config.ts";
import { makeTestSettings } from "../ws/serverSettings.testing.ts";
import { ServerSettingsService } from "../ws/serverSettings.ts";
import { BootstrapCommandLockService } from "../ws/wsBootstrap.lock.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import {
  cancelledReply,
  detachedReply,
  spawnedReply,
} from "./mobileGatewayActivation.native.fixture.ts";
import { RemoteMobileGatewayOwnerLive } from "./mobileGatewayOwner.ts";
import { RemoteMobileGatewayOwner } from "./mobileGatewayOwner.service.ts";
import { RemoteMobileGatewayRouteOwner } from "./mobileGatewayOwner.route.ts";
import {
  runNativeMobileGatewaySession,
  NativeMobileGatewaySessionError,
} from "./mobileGatewayNative.session.ts";
import {
  sessionScript as script,
  sessionStamp as stamp,
} from "./mobileGatewayNative.session.fixture.ts";

// Ordering test: authority, channel, upstream, preparation, assets, publication scope and native
// admission are recorded seams; the binding, worker, owner, process port and owner client are real.
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readFile: async (path: string) => {
      if (path === `/proc/${process.pid}/stat`)
        return `${process.pid} (node) ${["S", ...Array<string>(18).fill("0"), "123"].join(" ")}`;
      if (path === "/proc/sys/kernel/random/boot_id") return "fixture-boot\n";
      throw Error("Unexpected synthetic controller fixture read.");
    },
  };
});
vi.mock("./mobileGatewayActivation.authority.ts", async () =>
  (await import("./mobileGatewayNative.session.fixture.ts")).mockedAuthority(),
);
vi.mock("./localSupervisorService.leaseChannel.ts", async () =>
  (await import("./mobileGatewayNative.session.fixture.ts")).mockedChannel(),
);
vi.mock("./mobileGatewayListener.upstream.ts", async () =>
  (await import("./mobileGatewayNative.session.fixture.ts")).mockedUpstream(),
);
vi.mock("./mobileGatewayNative.prepare.ts", async () =>
  (await import("./mobileGatewayNative.session.fixture.ts")).mockedPreparation(),
);
vi.mock("./mobileGatewayActivation.native.assets.ts", async () =>
  (await import("./mobileGatewayNative.session.fixture.ts")).mockedAssets(),
);
vi.mock("./mobileGatewayNative.admission.ts", async () =>
  (await import("./mobileGatewayNative.session.fixture.ts")).mockedAdmission(),
);
vi.mock("../remote-agent/mobileGatewayLifecycle.publication.ts", async () =>
  (await import("./mobileGatewayNative.session.fixture.ts")).mockedPublication(),
);

const proof = Object.freeze({}) as VerifiedMobilePublication;
const configuration = { externalOrigin: stamp.backendExternalOrigin, port: 49322 };
const prelude = ["assets", "receipt", "prepare", "reserve", "mark-invoked"].map((e) => `${e}@0`);
const acquired = ["authority@0", "channel@0", "upstream:socket@0", "upstream:sealed@0"];
let client: NativeServiceLeaseClient | undefined;
afterEach(async () => {
  await client?.dispose();
  client = undefined;
  script.reset();
});

async function session(replies: Parameters<typeof successorFixture>[0]) {
  const f = successorFixture(replies);
  client = await connectNativeServiceLeaseClient(f.connection, { nativeEpoch: "epoch", stateDir });
  script.client = client;
  script.sent = f.sent;
  const settings = await Effect.runPromise(
    makeTestSettings({ mobileRemoteControl: { enabled: true } }),
  );
  const routeOwner = Layer.succeed(RemoteMobileGatewayRouteOwner, {
    withRoute: async (_input, operation, signal) =>
      operation({ assertCurrent: async () => {} }, signal),
  });
  const owner = await Effect.runPromise(
    RemoteMobileGatewayOwner.asEffect().pipe(
      Effect.provide(RemoteMobileGatewayOwnerLive.pipe(Layer.provide(routeOwner))),
    ),
  );
  const detach = new AbortController(),
    stop = new AbortController();
  const effect = runNativeMobileGatewaySession(proof, configuration, {
    detach: detach.signal,
    stop: stop.signal,
  }).pipe(
    Effect.provideService(RemoteMobileGatewayOwner, owner),
    Effect.provideService(ServerSettingsService, settings),
    Effect.provideService(ServerConfig, {
      mode: "remote",
      stateDir,
      authToken: "client-token",
    } as typeof ServerConfig.Service),
    Effect.provideService(BackendInstance, script.backend),
    Effect.provideService(RemoteBackendIdentityService, {
      authority: stamp.authority,
      installationFingerprint: stamp.installationFingerprint,
    } as typeof RemoteBackendIdentityService.Service),
    Effect.provideService(
      BootstrapCommandLockService,
      {} as typeof BootstrapCommandLockService.Service,
    ),
    Effect.provideService(RemoteAgentRuntimeOwners, {} as typeof RemoteAgentRuntimeOwners.Service),
  );
  script.disableConsent = () =>
    Effect.runPromise(settings.updateSettings({ mobileRemoteControl: { enabled: false } }));
  // The recorded upstream needs none of the real mobile route services.
  const fiber = Effect.runFork(
    effect as Effect.Effect<Effect.Success<typeof effect>, NativeMobileGatewaySessionError>,
  );
  const result = Effect.runPromise(Fiber.join(fiber)).then(
    (value) => ({ ok: true as const, value }),
    (cause: unknown) => ({ ok: false as const, cause }),
  );
  const running = () => vi.waitFor(() => expect(owner.getPhase()).toBe("running"));
  return { owner, detach, stop, fiber, result, running, wire: f.sent };
}
const repairFree = (outcome: { readonly ok: boolean; readonly cause?: unknown }) => {
  expect(outcome.ok).toBe(false);
  expect(outcome.cause).toBeInstanceOf(NativeMobileGatewaySessionError);
  expect((outcome.cause as NativeMobileGatewaySessionError).repairRequired).toBe(false);
};

it("seals the upstream and prepares with its configuration before the Start frame", async () => {
  const s = await session({ start: [spawnedReply], control: [exitedReply] });
  await s.running();
  expect(script.events).toEqual([...acquired, "prepare-factory:sealed@0", ...prelude]);
  expect(s.wire()).toEqual(["start"]);
  expect(script.credentials).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
  s.stop.abort();
  expect((await s.result).ok).toBe(true);
});

it("stops on request, records the exit, then releases the upstream before the channel", async () => {
  const s = await session({ start: [spawnedReply], control: [exitedReply] });
  await s.running();
  script.events.length = 0;
  s.stop.abort();
  expect(await s.result).toEqual({
    ok: true,
    value: { kind: "completed", disposition: "exit-recorded", value: undefined },
  });
  expect(script.events).toEqual([
    "admission:closed@1",
    "confirm:native-exit@2",
    "remove:native-exit@2",
    "upstream:released@2",
    "channel:released@2",
  ]);
  expect(s.wire()).toEqual(["start", "stop-original"]);
  expect(s.owner.getPhase()).toBe("idle");
});

it("detaches without stopping the native child and still releases the upstream last", async () => {
  const s = await session({ start: [spawnedReply], control: [detachedReply] });
  await s.running();
  script.events.length = 0;
  s.detach.abort();
  expect(await s.result).toEqual({
    ok: true,
    value: { kind: "completed", disposition: "detached", value: undefined },
  });
  expect(s.wire()).toEqual(["start", "detach"]);
  expect(script.events).toEqual([
    "admission:closed@1",
    "upstream:released@2",
    "channel:released@2",
  ]);
});

it("turns fiber interruption into a detach and waits for it before releasing", async () => {
  const s = await session({ start: [spawnedReply], control: [detachedReply] });
  await s.running();
  script.events.length = 0;
  s.fiber.interruptUnsafe();
  expect((await s.result).ok).toBe(false);
  expect(s.wire()).toEqual(["start", "detach"]);
  expect(script.events).toEqual([
    "admission:closed@1",
    "upstream:released@2",
    "channel:released@2",
  ]);
});

it("cancels the unlaunched intent when consent turns off before Start", async () => {
  script.onMarkInvoked = () => script.disableConsent();
  const s = await session({ control: [cancelledReply] });
  repairFree(await s.result);
  expect(s.wire()).toEqual(["cancel-pending"]);
  expect(script.events.slice(-4)).toEqual([
    "confirm:native-cancel@1",
    "remove:native-cancel@1",
    "upstream:released@1",
    "channel:released@1",
  ]);
});

it("starts and leaks nothing when authority or channel acquisition fails", async () => {
  script.fail = "authority";
  const authority = await session({});
  repairFree(await authority.result);
  expect(script.events).toEqual(["authority:failed@0"]);
  expect(authority.wire()).toEqual([]);
  await client?.dispose();
  script.reset();
  script.fail = "channel";
  const channel = await session({});
  repairFree(await channel.result);
  expect(script.events).toEqual(["authority@0", "channel:failed@0"]);
  expect(channel.wire()).toEqual([]);
});

it("stops the original and records its exit when owner admission fails after Start", async () => {
  script.fail = "admission";
  const s = await session({ start: [spawnedReply], control: [exitedReply] });
  repairFree(await s.result);
  expect(s.wire()).toEqual(["start", "stop-original"]);
  expect(script.events.slice(-4)).toEqual([
    "confirm:native-exit@2",
    "remove:native-exit@2",
    "upstream:released@2",
    "channel:released@2",
  ]);
  expect(s.owner.getPhase()).toBe("idle");
});
