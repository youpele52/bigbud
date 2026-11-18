import { Schema } from "effect";
import { expect, it } from "vitest";
import { build } from "./remoteAgentAdmission.fixtures.ts";
import { nextRemoteAgentRegistryRevision } from "./remoteAgentAdmission.types.ts";
import {
  emptyRemoteAgentRegistry,
  parseRemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";
import { RemoteAgentRegistryV2Schema } from "./remoteAgentInstall.registry.schema.ts";
import {
  pinRemoteAgentBuild,
  reserveRemoteAgentStage,
} from "./remoteAgentInstall.registry.transitions.ts";
import { MAX_MOBILE_REGISTRY_STAGES } from "./remoteAgentInstall.mobile.schema.ts";
import { mobileFixture } from "./remoteAgentInstall.mobile.fixtures.ts";
import {
  reserveRemoteAgentMobileStage,
  setRemoteAgentMobileConsent,
  verifyRemoteAgentMobileStageBytes,
} from "./remoteAgentInstall.mobile.transitions.ts";

function enabled() {
  const fixture = mobileFixture();
  const state = setRemoteAgentMobileConsent(
    emptyRemoteAgentRegistry(),
    { ...fixture.context, expectedConsentRevision: 0 },
    true,
  );
  return { ...fixture, state };
}
function reserved() {
  const fixture = enabled();
  const state = reserveRemoteAgentMobileStage(fixture.state, fixture.context, fixture.request);
  if (state.schemaVersion !== 3) throw new Error("Fixture must have v3 metadata.");
  return {
    ...fixture,
    state,
    completion: {
      id: fixture.request.id,
      releaseId: state.mobile.releases[0]!.id,
      gatewayBytes: fixture.gatewayBytes,
      assetsBytes: fixture.assetsBytes,
    },
  };
}

it("round trips v3 mobile journal through the existing admission revision helper", () => {
  const f = reserved();
  const next = nextRemoteAgentRegistryRevision(f.state, { pins: [] });
  expect(next.revision).toBe(f.state.revision + 1);
  expect(next.schemaVersion === 3 && next.mobile).toEqual(f.state.mobile);
});

it("preserves legacy v2 and v1 migration, and fences v2 readers on first mobile write", () => {
  const legacy = emptyRemoteAgentRegistry();
  expect(parseRemoteAgentRegistry(JSON.stringify(legacy))).toEqual(legacy);
  expect(
    parseRemoteAgentRegistry(JSON.stringify({ ...legacy, schemaVersion: 1 })).schemaVersion,
  ).toBe(2);
  const { state } = enabled();
  expect(state.schemaVersion).toBe(3);
  expect(() => Schema.decodeUnknownSync(RemoteAgentRegistryV2Schema)(state)).toThrow();
  expect(() => parseRemoteAgentRegistry(JSON.stringify({ ...legacy, schemaVersion: 3 }))).toThrow();
});

it("keeps every P4 collection/selector unchanged and sidecars out of builds/slots", () => {
  const f = mobileFixture();
  const base = build(1, true);
  const state = parseRemoteAgentRegistry(
    JSON.stringify({
      ...emptyRemoteAgentRegistry(),
      builds: [base],
      promotionSequence: 1,
      pins: [{ owner: "existing", buildId: base.id }],
      stages: [{ id: "base-stage", buildId: base.id, phase: "published" }],
      launches: [{ id: "base-launch", buildId: base.id, phase: "ready", epoch: "base-epoch" }],
      admissions: [
        { id: "base-connection", buildId: base.id, phase: "ready", epoch: "base-epoch" },
      ],
      admissionRetirements: [
        { id: "retired-connection", buildId: base.id, epoch: "old", outcome: "selected" },
      ],
      slotReservations: [
        {
          id: "slot-0:base",
          slotId: "slot-0",
          requestId: "base-update",
          buildId: base.id,
          phase: "occupied",
        },
      ],
      updates: [{ requestId: "base-update", buildId: base.id, phase: "checking" }],
      retirementReservations: [
        { id: "retire", buildId: base.id, generation: base.runtime.generation, phase: "failed" },
      ],
      restartReservations: [
        {
          id: "restart",
          buildId: base.id,
          generation: base.runtime.generation,
          expectedEpoch: "base-epoch",
          phase: "failed",
        },
      ],
      current: base.id,
      predecessor: base.id,
      currentConnectionId: "base-connection",
    }),
  );
  const mobile = reserveRemoteAgentMobileStage(
    setRemoteAgentMobileConsent(state, { ...f.context, expectedConsentRevision: 0 }, true),
    f.context,
    f.request,
  );
  for (const [key, value] of Object.entries(state))
    if (key !== "schemaVersion" && key !== "revision")
      expect(mobile[key as keyof typeof mobile]).toEqual(value);
  const pinned = pinRemoteAgentBuild(mobile, "new-P4-pin", base.id);
  expect(pinned.schemaVersion).toBe(3);
  if (pinned.schemaVersion === 3 && mobile.schemaVersion === 3)
    expect(pinned.mobile).toEqual(mobile.mobile);
  expect(pinned.builds).toHaveLength(1);
  expect(pinned.slotReservations).toHaveLength(1);
});

it.each(["authorityId", "keyEpoch", "keyFingerprint", "installationFingerprint"])(
  "rejects foreign %s even for consent disable",
  (field) => {
    const f = enabled();
    const foreign =
      field === "installationFingerprint"
        ? { ...f.context.owner, installationFingerprint: "sha256:" + "c".repeat(64) }
        : {
            ...f.context.owner,
            authority: {
              ...f.context.owner.authority,
              [field]:
                field === "keyEpoch"
                  ? 2
                  : field === "authorityId"
                    ? "c".repeat(32)
                    : "sha256:" + "c".repeat(64),
            },
          };
    expect(() =>
      setRemoteAgentMobileConsent(f.state, { ...f.context, owner: foreign }, false),
    ).toThrow(/mismatch/);
    expect(() =>
      reserveRemoteAgentMobileStage(f.state, { ...f.context, owner: foreign }, f.request),
    ).toThrow(/mismatch/);
  },
);

it.each([
  "slotReservations",
  "updates",
  "admissionRetirements",
  "retirementReservations",
  "restartReservations",
])("v3 rejects null or missing %s instead of applying legacy migration defaults", (field) => {
  const f = reserved();
  const raw = JSON.parse(JSON.stringify(f.state));
  raw[field] = null;
  expect(() => parseRemoteAgentRegistry(JSON.stringify(raw))).toThrow();
  delete raw[field];
  expect(() => parseRemoteAgentRegistry(JSON.stringify(raw))).toThrow();
});

it("fences stale revoke/re-enable attempts permanently, without schema downgrade", () => {
  const f = reserved();
  const revoked = setRemoteAgentMobileConsent(f.state, f.context, false);
  expect(revoked.schemaVersion).toBe(3);
  expect(() => setRemoteAgentMobileConsent(revoked, f.context, true)).toThrow(/Stale/);
  const reen = setRemoteAgentMobileConsent(
    revoked,
    { ...f.context, expectedConsentRevision: 2 },
    true,
  );
  expect(() => verifyRemoteAgentMobileStageBytes(reen, f.context, f.completion)).toThrow(/Stale/);
  expect(() =>
    reserveRemoteAgentMobileStage(reen, { ...f.context, expectedConsentRevision: 3 }, f.request),
  ).toThrow(/fenced/);
  if (reen.schemaVersion === 3) {
    expect(reen.mobile.consent.revision).toBe(3);
    expect(reen.mobile.stages[0]?.phase).toBe("cancelled");
  }
});

it("requires separate enabled mobile consent even for a valid signed release", () => {
  const f = mobileFixture();
  const disabled = setRemoteAgentMobileConsent(
    emptyRemoteAgentRegistry(),
    { ...f.context, expectedConsentRevision: 0 },
    false,
  );
  expect(disabled.schemaVersion).toBe(3);
  expect(() => reserveRemoteAgentMobileStage(disabled, f.context, f.request)).toThrow(/disabled/);
  if (disabled.schemaVersion === 3) {
    expect(disabled.mobile.stages).toEqual([]);
    expect(disabled.mobile.releases).toEqual([]);
  }
});

it("reverifies pinned signatures/host/bytes on reserve and idempotent completion", () => {
  const f = reserved();
  expect(() =>
    reserveRemoteAgentMobileStage(f.state, { ...f.context, trustedKeys: {} }, f.request),
  ).toThrow(/signature/);
  expect(() =>
    reserveRemoteAgentMobileStage(
      f.state,
      { ...f.context, host: { ...f.context.host, backendVersion: "other" } },
      f.request,
    ),
  ).toThrow(/incompatible/);
  expect(() =>
    verifyRemoteAgentMobileStageBytes(f.state, f.context, {
      ...f.completion,
      assetsBytes: Buffer.alloc(f.assetsBytes.length),
    }),
  ).toThrow(/SHA-256/);
  const completed = verifyRemoteAgentMobileStageBytes(f.state, f.context, f.completion);
  expect(completed.schemaVersion === 3 && completed.mobile.stages[0]?.phase).toBe(
    "artifact-bytes-verified",
  );
  expect(verifyRemoteAgentMobileStageBytes(completed, f.context, f.completion)).toBe(completed);
  expect(() =>
    verifyRemoteAgentMobileStageBytes(completed, { ...f.context, trustedKeys: {} }, f.completion),
  ).toThrow(/signature/);
  expect(() =>
    verifyRemoteAgentMobileStageBytes(completed, f.context, {
      ...f.completion,
      gatewayBytes: Buffer.alloc(f.gatewayBytes.length),
    }),
  ).toThrow(/SHA-256/);
});

it("fences request reuse with another release, controller, or completion release ID", () => {
  const f = reserved();
  expect(() =>
    reserveRemoteAgentMobileStage(f.state, f.context, mobileFixture("2").request),
  ).toThrow(/identity/);
  const foreign = {
    ...f.context,
    controller: { ...f.context.controller, startedAt: "reused-pid" },
  };
  expect(() => reserveRemoteAgentMobileStage(f.state, foreign, f.request)).toThrow(/identity/);
  expect(() => verifyRemoteAgentMobileStageBytes(f.state, foreign, f.completion)).toThrow(
    /identity/,
  );
  expect(() =>
    verifyRemoteAgentMobileStageBytes(f.state, f.context, {
      ...f.completion,
      releaseId: "mobile-release:" + "0".repeat(64),
    }),
  ).toThrow(/identity/);
});

it("fails closed at bounded journal capacity without evicting replay fences", () => {
  const f = enabled();
  let state = f.state;
  for (let index = 0; index < MAX_MOBILE_REGISTRY_STAGES; index++)
    state = reserveRemoteAgentMobileStage(state, f.context, { ...f.request, id: `stage-${index}` });
  expect(() =>
    reserveRemoteAgentMobileStage(state, f.context, { ...f.request, id: "overflow" }),
  ).toThrow(/budget/);
  expect(state.schemaVersion === 3 && state.mobile.stages.length).toBe(MAX_MOBILE_REGISTRY_STAGES);
});

it("bounds distinct signed release pairs without removing old stage replay fences", () => {
  const f = enabled();
  let state = f.state;
  for (let index = 1; index <= 8; index++)
    state = reserveRemoteAgentMobileStage(state, f.context, {
      ...mobileFixture(String(index)).request,
      id: `release-stage-${index}`,
    });
  expect(() =>
    reserveRemoteAgentMobileStage(state, f.context, {
      ...mobileFixture("9").request,
      id: "overflow-release",
    }),
  ).toThrow(/budget/);
  expect(state.schemaVersion === 3 && state.mobile.releases.length).toBe(8);
});

it.each([
  "top",
  "mobile",
  "owner",
  "consent",
  "release",
  "artifact",
  "compatibility",
  "signature",
  "stage",
  "controller",
  "base-build",
  "base-runtime",
])("v3 refuses unknown %s fields so future state cannot be stripped", (where) => {
  const f = reserved();
  const base = build(1, false);
  const state = reserveRemoteAgentStage(f.state, "base-stage", base);
  const raw = JSON.parse(JSON.stringify(state));
  const node = {
    top: raw,
    mobile: raw.mobile,
    owner: raw.mobile.owner,
    consent: raw.mobile.consent,
    release: raw.mobile.releases[0],
    artifact: raw.mobile.releases[0].gateway,
    compatibility: raw.mobile.releases[0].gateway.compatibility,
    signature: raw.mobile.releases[0].gateway.signature,
    stage: raw.mobile.stages[0],
    controller: raw.mobile.stages[0].controller,
    "base-build": raw.builds[0],
    "base-runtime": raw.builds[0].runtime,
  }[where]!;
  node.futureProtocol = { doNotStrip: true };
  expect(() => parseRemoteAgentRegistry(JSON.stringify(raw))).toThrow();
});
