/** Recorded seams for the native session ordering test; never a native, socket or journal proof. */
import * as Effect from "effect/Effect";
import type { NativeServiceLeaseClient } from "../remote-agent/remoteAgentServiceLeaseClient.ts";
import { launch, stateDir } from "../remote-agent/remoteAgentServiceLease.test.fixture.ts";
import type { RemoteMobileAdmissionStamp } from "../mobile/Services/MobileRemoteControlAdmission.ts";
import type { BackendInstanceShape } from "../startup/backendInstance.ts";
import { ServerConfig, type ServerConfigShape } from "../startup/config.ts";

export const sessionStamp: RemoteMobileAdmissionStamp = {
  authority: {
    authorityId: "a".repeat(32),
    keyEpoch: 1,
    keyFingerprint: `sha256:${"b".repeat(64)}`,
  },
  installationFingerprint: `sha256:${"c".repeat(64)}`,
  consentRevision: 1,
  backendExternalOrigin: "https://fixture.ts.net",
};
const backend = {
  nonce: "backend-nonce",
  pid: process.pid,
  startedAt: "123",
  stateDir,
  lockPath: `${stateDir}/backend.lock`,
  assertHeld: async () => {},
} as unknown as BackendInstanceShape;

export const sessionScript = {
  events: [] as string[],
  credentials: [] as string[],
  client: undefined as NativeServiceLeaseClient | undefined,
  sent: (() => []) as () => string[],
  fail: undefined as "authority" | "channel" | "admission" | undefined,
  onMarkInvoked: undefined as (() => Promise<unknown>) | undefined,
  disableConsent: (async () => {}) as () => Promise<unknown>,
  backend,
  /** Each event records how many native frames were already on the wire. */
  record(event: string) {
    this.events.push(`${event}@${this.sent().length}`);
  },
  reset() {
    this.events.length = 0;
    this.credentials.length = 0;
    this.fail = undefined;
    this.onMarkInvoked = undefined;
    this.client = undefined;
    this.sent = () => [];
  },
};
const s = sessionScript;
const client = () => {
  if (!s.client) throw Error("Fixture client missing.");
  return s.client;
};

export const mockedAuthority = () => ({
  acquireMobileGatewayActivationAuthority: Effect.suspend(() => {
    if (s.fail === "authority") {
      s.record("authority:failed");
      return Effect.fail(Error("Fixture authority unavailable."));
    }
    s.record("authority");
    return Effect.succeed({ assertAuthority: async () => {} });
  }),
});
export const mockedChannel = () => {
  const token = Object.freeze({});
  return {
    acquireManagedNativeLeaseChannel: () =>
      Effect.acquireRelease(
        Effect.suspend(() => {
          if (s.fail === "channel") {
            s.record("channel:failed");
            return Effect.fail(Error("Fixture channel unavailable."));
          }
          s.record("channel");
          return Effect.succeed(token);
        }),
        () => Effect.sync(() => s.record("channel:released")),
      ),
    managedNativeLeaseChannel: () => ({ client: client() }),
  };
};
export const mockedUpstream = () => ({
  serveSealedMobileUpstream: (
    config: ServerConfigShape,
    _owner: unknown,
    credential: string,
    assertAllowed: () => Promise<void>,
  ) =>
    Effect.gen(function* () {
      s.credentials.push(credential);
      yield* Effect.acquireRelease(
        Effect.promise(async () => {
          await assertAllowed();
          s.record("upstream:socket");
        }),
        () => Effect.sync(() => s.record("upstream:released")),
      );
      yield* Effect.promise(assertAllowed);
      s.record("upstream:sealed");
      return Object.freeze({
        ...config,
        remoteMobile: { sealed: true },
      }) as unknown as ServerConfigShape;
    }),
});
export const mockedPreparation = () => ({
  makeNativeMobileGatewayLaunchPreparation: () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      s.record(`prepare-factory:${config.remoteMobile ? "sealed" : "unsealed"}`);
      return {
        prepare: async (assets: { readonly nonce: string }, attempt: never) => {
          s.record("prepare");
          return client().prepareStart(attempt, launch(assets.nonce));
        },
        reserve: async () => {
          s.record("reserve");
          return Object.freeze({});
        },
        markInvoked: async () => {
          s.record("mark-invoked");
          await s.onMarkInvoked?.();
        },
      };
    }),
});
export const mockedAssets = () => ({
  nativeMobileActivationAssets: () => ({
    prepare: async (nonce: string) => {
      s.record("assets");
      return Object.freeze({ nonce });
    },
    writeReceipt: async () => s.record("receipt"),
    confirmExit: async (_a: unknown, owner: NativeServiceLeaseClient, _p: unknown, exit: never) => {
      const kind = owner.exitEvidence(exit).kind;
      s.record(`confirm:${kind}`);
      return { kind };
    },
    confirmCancellation: async (
      _a: unknown,
      owner: NativeServiceLeaseClient,
      _p: unknown,
      cancellation: never,
    ) => {
      const kind = owner.cancellationEvidence(cancellation).kind;
      s.record(`confirm:${kind}`);
      return { kind };
    },
    remove: async (_assets: unknown, cleanup?: { readonly kind: string }) =>
      s.record(`remove:${cleanup?.kind ?? "unarmed"}`),
  }),
});
export const mockedAdmission = () => ({
  mobileGatewayNativeAdmission: async () => {
    if (s.fail === "admission") throw Error("Fixture native admission refused.");
    return {
      read: async () => sessionStamp,
      close: async () => s.record("admission:closed"),
    };
  },
});
export const mockedPublication = () => ({
  withMobilePublicationOwner: <A>(
    _proof: unknown,
    operation: (context: unknown, signal: AbortSignal) => Promise<A>,
    signal?: AbortSignal,
  ) =>
    operation(
      {
        authority: { owner: backend },
        paths: {
          owner: {
            authority: sessionStamp.authority,
            installationFingerprint: sessionStamp.installationFingerprint,
          },
        },
      },
      signal ?? new AbortController().signal,
    ),
  withMobilePublicationLifetime: <A>(
    _proof: unknown,
    operation: (signal: AbortSignal) => Promise<A>,
    external?: AbortSignal,
  ) => operation(external ?? new AbortController().signal),
});
