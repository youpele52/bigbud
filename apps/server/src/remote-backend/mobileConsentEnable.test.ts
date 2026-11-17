import { publicationFixture } from "../remote-agent/mobileOptionalPublication.test-fixtures.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BackendInstance } from "../startup/backendInstance.ts";
import { ServerConfig } from "../startup/config.ts";
import { emptyRemoteAgentRegistry } from "../remote-agent/remoteAgentInstall.registry.ts";
import { setRemoteAgentMobileConsent } from "../remote-agent/remoteAgentInstall.mobile.transitions.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import {
  enableMobileConsentTransition,
  MobileConsentJournalError,
  mobileConsentState,
  RemoteMobileConsentJournal,
  RemoteMobileConsentJournalLive,
} from "./mobileConsentEnable.ts";

type Fixture = Awaited<ReturnType<typeof publicationFixture>>;
let fixture: Fixture | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});
const code = (run: () => unknown) => {
  try {
    run();
  } catch (cause) {
    return cause instanceof MobileConsentJournalError ? cause.code : "other";
  }
  return "none";
};

it("keeps the revision on an idempotent grant and bumps it on every real transition", async () => {
  const f = (fixture = await publicationFixture());
  const enabled = f.read();
  expect(mobileConsentState(enabled)).toEqual({ enabled: true, revision: 1 });
  expect(enableMobileConsentTransition(enabled, f.pin, 1)).toBe(enabled);
  expect(code(() => enableMobileConsentTransition(enabled, f.pin, 0))).toBe("stale");

  const revoked = setRemoteAgentMobileConsent(
    enabled,
    { owner: f.pin, expectedConsentRevision: 1 },
    false,
  );
  expect(mobileConsentState(revoked)).toEqual({ enabled: false, revision: 2 });
  expect(code(() => enableMobileConsentTransition(revoked, f.pin, 1))).toBe("stale");
  const regranted = enableMobileConsentTransition(revoked, f.pin, 2);
  expect(mobileConsentState(regranted)).toEqual({ enabled: true, revision: 3 });
  // No stage or attempt minted under revision 1 can match the new grant: revoke-only.
  if (regranted.schemaVersion !== 3) throw Error("v3 expected");
  expect(regranted.mobile.stages.every((stage) => stage.phase === "cancelled")).toBe(true);
  expect(regranted.mobile.consent.revision).not.toBe(1);
});

it("refuses a journal without an installed agent and a foreign mobile owner", async () => {
  const f = (fixture = await publicationFixture());
  expect(code(() => enableMobileConsentTransition(emptyRemoteAgentRegistry(), f.pin, 0))).toBe(
    "not-installed",
  );
  const foreign = {
    ...f.pin,
    authority: { ...f.pin.authority, authorityId: "f".repeat(32) },
  };
  expect(code(() => enableMobileConsentTransition(f.read(), foreign, 1))).toBe("unavailable");
});

async function journal(f: Fixture) {
  const base = ServerConfig.layerTest(f.home, join(f.home, "settings-config")).pipe(
    Layer.provide(NodeServices.layer),
  );
  const config = Layer.effect(
    ServerConfig,
    Effect.map(Effect.service(ServerConfig), (value) => ({
      ...value,
      mode: "remote" as const,
      stateDir: f.stateDir,
    })),
  ).pipe(Layer.provide(base));
  return Effect.runPromise(
    Effect.service(RemoteMobileConsentJournal).pipe(
      Effect.provide(
        RemoteMobileConsentJournalLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              config,
              Layer.succeed(BackendInstance, f.owner()),
              Layer.succeed(RemoteBackendIdentityService, f.identity),
            ),
          ),
        ),
      ),
    ),
  );
}

it("grants through the real locked authority and journal CAS", async () => {
  const f = (fixture = await publicationFixture());
  const live = await journal(f);
  expect(await Effect.runPromise(live.read)).toEqual({ enabled: true, revision: 1 });
  expect(await Effect.runPromise(live.enable(1))).toEqual({
    enabled: true,
    revision: 1,
    changed: false,
  });
  f.replaceState(
    setRemoteAgentMobileConsent(f.read(), { owner: f.pin, expectedConsentRevision: 1 }, false),
  );
  const stale = await Effect.runPromise(Effect.flip(live.enable(1)));
  expect(stale.code).toBe("stale");
  expect(mobileConsentState(f.read())).toEqual({ enabled: false, revision: 2 });
  expect(await Effect.runPromise(live.enable(2))).toEqual({
    enabled: true,
    revision: 3,
    changed: true,
  });
  expect(mobileConsentState(f.read())).toEqual({ enabled: true, revision: 3 });
});
