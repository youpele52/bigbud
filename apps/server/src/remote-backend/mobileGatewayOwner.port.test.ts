import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, expect, it, vi } from "vitest";
import type { VerifiedMobilePublication } from "../remote-agent/mobileOptionalPublication.ts";
import type { VerifiedNativeLease } from "../remote-agent/remoteAgentServiceLeaseClient.ts";
import { RemoteAgentRuntimeOwners } from "../persistence/Layers/RemoteAgentRuntimeBindings.service.ts";
import type { RemoteMobileAdmissionStamp } from "../mobile/Services/MobileRemoteControlAdmission.ts";
import { ServerConfig } from "../startup/config.ts";
import { makeTestSettings } from "../ws/serverSettings.testing.ts";
import { ServerSettingsService } from "../ws/serverSettings.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import { RemoteMobileGatewayOwnerLive } from "./mobileGatewayOwner.ts";
import { RemoteMobileGatewayOwner } from "./mobileGatewayOwner.service.ts";
import { RemoteMobileGatewayRouteOwner } from "./mobileGatewayOwner.route.ts";
import { RemoteMobileGatewayStatus } from "./mobileGatewayStatus.ts";
import { MobileGatewayAdmissionRevoked } from "./mobileGatewayOwner.read.ts";
import {
  NATIVE_GATEWAY_LIVENESS_INTERVAL_MS,
  nativeMobileGatewayProcessPort,
  type MobileGatewayProcessPort,
} from "./mobileGatewayOwner.port.ts";

// Port-only test: the native admission and lease lookup are scripted; the owner body is real.
const script = vi.hoisted(() => ({
  events: [] as string[],
  reads: [] as Array<(signal: AbortSignal) => Promise<unknown>>,
  closed: 0,
}));
vi.mock("./mobileGatewayActivation.native.ts", () => ({
  nativeMobileActivationLease: () => ({ client: {}, pending: {} }),
}));
vi.mock("./mobileGatewayNative.admission.ts", () => ({
  mobileGatewayNativeAdmission: async () => ({
    read: (signal: AbortSignal) => {
      script.events.push("read");
      const next = script.reads.shift();
      return next ? next(signal) : Promise.resolve(stamp);
    },
    close: async () => void script.closed++,
  }),
}));
vi.mock("../remote-agent/mobileGatewayLifecycle.publication.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withMobilePublicationLifetime: <A>(
    _proof: unknown,
    operation: (signal: AbortSignal) => Promise<A>,
    external: AbortSignal,
  ) => operation(external),
}));

const stamp: RemoteMobileAdmissionStamp = {
  authority: {
    authorityId: "a".repeat(32),
    keyEpoch: 1,
    keyFingerprint: `sha256:${"b".repeat(64)}`,
  },
  installationFingerprint: `sha256:${"c".repeat(64)}`,
  consentRevision: 1,
  backendExternalOrigin: "https://fixture.ts.net",
};
const input = { nonce: "native-attempt", port: 49322, externalOrigin: stamp.backendExternalOrigin };
const proof = Object.freeze({}) as VerifiedMobilePublication;
afterEach(() => {
  script.events.length = 0;
  script.reads.length = 0;
  script.closed = 0;
});

async function start(route: { assertCurrent?: () => Promise<void> } = {}) {
  const settings = await Effect.runPromise(
    makeTestSettings({ mobileRemoteControl: { enabled: true } }),
  );
  const routeOwner = Layer.succeed(RemoteMobileGatewayRouteOwner, {
    withRoute: async (_input, operation, signal) => {
      script.events.push("route");
      return operation(
        {
          assertCurrent: async () => {
            script.events.push("assert");
            await route.assertCurrent?.();
          },
        },
        signal,
      );
    },
  });
  const { owner, status } = await Effect.runPromise(
    Effect.gen(function* () {
      return { owner: yield* RemoteMobileGatewayOwner, status: yield* RemoteMobileGatewayStatus };
    }).pipe(Effect.provide(RemoteMobileGatewayOwnerLive.pipe(Layer.provide(routeOwner)))),
  );
  const worker = new AbortController();
  const runWith = (port: MobileGatewayProcessPort<RemoteAgentRuntimeOwners>) =>
    Effect.runPromise(
      owner.runWith(proof, input, port).pipe(
        Effect.provideService(ServerConfig, { mode: "remote" } as typeof ServerConfig.Service),
        Effect.provideService(RemoteBackendIdentityService, {
          authority: stamp.authority,
          installationFingerprint: stamp.installationFingerprint,
        } as typeof RemoteBackendIdentityService.Service),
        Effect.provideService(ServerSettingsService, settings),
        Effect.provideService(
          RemoteAgentRuntimeOwners,
          {} as typeof RemoteAgentRuntimeOwners.Service,
        ),
      ),
    );
  const native = () => nativeMobileGatewayProcessPort({} as VerifiedNativeLease, worker.signal);
  return { owner, status, settings, worker, runWith, native };
}
/** Wrapped so awaiting admission never awaits the whole lifetime. */
const admitted = async (f: Awaited<ReturnType<typeof start>>) => {
  const run = f.runWith(f.native());
  void run.catch(() => {});
  await vi.waitFor(() => expect(f.owner.getPhase()).toBe("running"));
  return { run };
};

it("admits only after route verification and an equal second stamp", async () => {
  const f = await start();
  const { run } = await admitted(f);
  expect(script.events).toEqual(["read", "route", "assert", "read"]);
  expect(await Effect.runPromise(f.status.readAdmission!())).toEqual(stamp);
  expect(f.status.verifiedExternalOrigin).toBe(stamp.backendExternalOrigin);
  f.worker.abort();
  await run;
  expect(f.owner.getPhase()).toBe("idle");
  expect(script.closed).toBe(1);
});

it("never admits when route verification or stamp equality fails, and leaves no repair", async () => {
  const route = await start({ assertCurrent: async () => Promise.reject(Error("route lost")) });
  await expect(route.runWith(route.native())).rejects.toThrow();
  expect(route.owner.getPhase()).toBe("idle");
  expect(script.events).toEqual(["read", "route", "assert"]);
  script.events.length = 0;
  const changed = await start();
  script.reads.push(
    async () => stamp,
    async () => ({ ...stamp, consentRevision: 2 }),
  );
  await expect(changed.runWith(changed.native())).rejects.toThrow();
  expect(changed.owner.getPhase()).toBe("idle");
  expect(await Effect.runPromise(changed.status.readAdmission!())).toBeNull();
});

it("refuses a structural port before beginning any owner lifetime", async () => {
  const f = await start();
  const fake = Object.freeze({}) as MobileGatewayProcessPort<RemoteAgentRuntimeOwners>;
  await expect(f.runWith(fake)).rejects.toThrow();
  expect(f.owner.getPhase()).toBe("idle");
  expect(script.events).toEqual([]);
});

it("ends admission as disabled when the consent snapshot turns off", async () => {
  const off = await start();
  await Effect.runPromise(off.settings.updateSettings({ mobileRemoteControl: { enabled: false } }));
  await off.runWith(off.native());
  expect(script.events).toEqual([]);
  const f = await start();
  const { run } = await admitted(f);
  const ended = Effect.runPromise(f.status.watchAdmissionEnd!(stamp));
  await vi.waitFor(() => expect(script.events.length).toBe(6));
  await Effect.runPromise(f.settings.updateSettings({ mobileRemoteControl: { enabled: false } }));
  expect(await ended).toBe("disabled");
  await run;
  expect(f.owner.getPhase()).toBe("idle");
});

it("ends admission as disabled when a liveness read throws", async () => {
  const f = await start();
  const { run } = await admitted(f);
  script.reads.push(async () => Promise.reject(Error("native status uncertain")));
  expect(await Effect.runPromise(f.status.readAdmission!())).toBeNull();
  expect(await Effect.runPromise(f.status.watchAdmissionEnd!(stamp))).toBe("disabled");
  await run;
  expect(f.owner.getPhase()).toBe("idle");
});

it("revokes admission on a changed stamp or a revoked native generation", async () => {
  for (const next of [
    async () => ({ ...stamp, consentRevision: 2 }),
    async () => Promise.reject(new MobileGatewayAdmissionRevoked("generation changed")),
  ]) {
    const f = await start();
    const { run } = await admitted(f);
    const ended = Effect.runPromise(f.status.watchAdmissionEnd!(stamp));
    await vi.waitFor(() => expect(script.events.length).toBe(6));
    script.reads.push(next);
    expect(await Effect.runPromise(f.status.readAdmission!())).toBeNull();
    expect(await ended).toBe("revoked");
    await run;
    script.events.length = 0;
  }
});

/** Polls on real setTimeout only; vi.waitFor would use the faked interval. */
const until = async (ready: () => boolean) => {
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 5));
    if (ready()) break;
  }
  expect(ready()).toBe(true);
};

it("ends the native lifetime when an idle liveness read fails, without a mobile request", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const f = await start();
    const run = f.runWith(f.native());
    void run.catch(() => {});
    await until(() => f.owner.getPhase() === "running");
    script.events.length = 0;
    vi.advanceTimersByTime(NATIVE_GATEWAY_LIVENESS_INTERVAL_MS);
    await until(() => script.events.length === 1);
    script.reads.push(async () => Promise.reject(Error("native scope exited")));
    vi.advanceTimersByTime(NATIVE_GATEWAY_LIVENESS_INTERVAL_MS);
    await expect(run).rejects.toThrow();
    expect(script.events).toEqual(["read", "read"]);
    expect(f.owner.getPhase()).toBe("idle");
    expect(script.closed).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});
