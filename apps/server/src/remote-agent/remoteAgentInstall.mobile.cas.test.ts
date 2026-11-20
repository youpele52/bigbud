import { expect, it } from "vitest";
import { build } from "./remoteAgentAdmission.fixtures.ts";
import { emptyRemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";
import { makeRemoteAgentRegistryStore } from "./remoteAgentInstall.registry.store.ts";
import {
  pinRemoteAgentBuild,
  reserveRemoteAgentStage,
} from "./remoteAgentInstall.registry.transitions.ts";
import { memoryRegistryCommand, mobileFixture } from "./remoteAgentInstall.mobile.fixtures.ts";
import {
  reserveRemoteAgentMobileStage,
  setRemoteAgentMobileConsent,
  verifyRemoteAgentMobileStageBytes,
} from "./remoteAgentInstall.mobile.transitions.ts";

it("reconciles a lost v3 acknowledgement through the unchanged existing store", async () => {
  const f = mobileFixture();
  const base = build(1, false);
  const initial = reserveRemoteAgentStage(emptyRemoteAgentRegistry(), "P4-stage", base);
  const command = memoryRegistryCommand(initial);
  const store = makeRemoteAgentRegistryStore("/tmp/agent", command);
  command.loseNextAck();
  const upgraded = await store.update((state) =>
    setRemoteAgentMobileConsent(state, { ...f.context, expectedConsentRevision: 0 }, true),
  );
  expect(upgraded.schemaVersion).toBe(3);
  expect(upgraded.revision).toBe(initial.revision + 1);
  expect(upgraded.stages).toEqual(initial.stages);
  command.loseNextAck();
  const reserved = await store.update((state) =>
    reserveRemoteAgentMobileStage(state, f.context, f.request),
  );
  if (reserved.schemaVersion !== 3) throw new Error("Expected fenced metadata.");
  const complete = {
    id: f.request.id,
    releaseId: reserved.mobile.releases[0]!.id,
    gatewayBytes: f.gatewayBytes,
    assetsBytes: f.assetsBytes,
  };
  command.loseNextAck();
  const verified = await store.update((state) =>
    verifyRemoteAgentMobileStageBytes(state, f.context, complete),
  );
  expect(verified.schemaVersion === 3 && verified.mobile.stages[0]?.phase).toBe(
    "artifact-bytes-verified",
  );
  expect(
    (await store.update((state) => verifyRemoteAgentMobileStageBytes(state, f.context, complete)))
      .revision,
  ).toBe(verified.revision);
  expect((await store.read()).builds).toEqual(initial.builds);
});

it("retries a P4/mobile conflict and retains both writes in one global revision sequence", async () => {
  const f = mobileFixture();
  const base = build(1, false);
  const seeded = reserveRemoteAgentStage(emptyRemoteAgentRegistry(), "P4-stage", base);
  const initial = setRemoteAgentMobileConsent(
    seeded,
    { ...f.context, expectedConsentRevision: 0 },
    true,
  );
  const command = memoryRegistryCommand(initial);
  const store = makeRemoteAgentRegistryStore("/tmp/agent", command);
  command.beforeNextCas((state) => pinRemoteAgentBuild(state, "concurrent-P4-owner", base.id));
  const result = await store.update((state) =>
    reserveRemoteAgentMobileStage(state, f.context, f.request),
  );
  expect(result.revision).toBe(initial.revision + 2);
  expect(result.pins).toContainEqual({ owner: "concurrent-P4-owner", buildId: base.id });
  expect(result.schemaVersion === 3 && result.mobile.stages).toHaveLength(1);
  expect(result.builds).toHaveLength(1);
  expect(result.slotReservations).toHaveLength(0);
});

it("rechecks consent after CAS conflict so revoke/re-enable cannot commit a stale intent", async () => {
  const f = mobileFixture();
  const initial = setRemoteAgentMobileConsent(
    emptyRemoteAgentRegistry(),
    { ...f.context, expectedConsentRevision: 0 },
    true,
  );
  const command = memoryRegistryCommand(initial);
  const store = makeRemoteAgentRegistryStore("/tmp/agent", command);
  command.beforeNextCas((state) =>
    setRemoteAgentMobileConsent(
      setRemoteAgentMobileConsent(state, f.context, false),
      { ...f.context, expectedConsentRevision: 2 },
      true,
    ),
  );
  await expect(
    store.update((state) => reserveRemoteAgentMobileStage(state, f.context, f.request)),
  ).rejects.toThrow(/Stale/);
  const result = await store.read();
  expect(result.schemaVersion === 3 && result.mobile.consent.revision).toBe(3);
  expect(result.schemaVersion === 3 && result.mobile.stages).toEqual([]);
  expect(result.schemaVersion === 3 && result.mobile.releases).toEqual([]);
});

it("rejects foreign owner writes without mutating shared P4/mobile metadata", async () => {
  const f = mobileFixture();
  const initial = setRemoteAgentMobileConsent(
    emptyRemoteAgentRegistry(),
    { ...f.context, expectedConsentRevision: 0 },
    true,
  );
  const command = memoryRegistryCommand(initial);
  const store = makeRemoteAgentRegistryStore("/tmp/agent", command);
  const foreign = {
    ...f.context,
    owner: { ...f.context.owner, installationFingerprint: "sha256:" + "f".repeat(64) },
  };
  await expect(
    store.update((state) => setRemoteAgentMobileConsent(state, foreign, false)),
  ).rejects.toThrow(/mismatch/);
  expect(await store.read()).toEqual(initial);
});
