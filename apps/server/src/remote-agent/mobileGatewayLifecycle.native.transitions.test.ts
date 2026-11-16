import { afterEach, expect, it } from "vitest";
import { publicationFixture } from "./mobileOptionalPublication.test-fixtures.ts";
import { gatewayContext } from "./mobileGatewayLifecycle.test-fixtures.ts";
import {
  reserveNativeMobileGatewayAttempt,
  completeNativeMobileGatewayAttempt,
} from "./mobileGatewayLifecycle.native.transitions.ts";
import {
  advanceMobileGatewayAttempt,
  mobileGatewayBuildPin,
} from "./mobileGatewayLifecycle.transitions.ts";
import { cancelUnlaunchedMobileGatewayAttempt } from "./mobileGatewayLifecycle.cancel.ts";
import { pinRemoteAgentBuild } from "./remoteAgentInstall.registry.transitions.ts";
import { setRemoteAgentMobileConsent } from "./remoteAgentInstall.mobile.transitions.ts";
import { makeRemoteAgentRegistryStore } from "./remoteAgentInstall.registry.store.ts";
import { memoryRegistryCommand } from "./remoteAgentInstall.mobile.fixtures.ts";
import {
  parseRemoteAgentRegistry,
  type RemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";
import type { MobileNativeGatewayOwnership } from "./mobileGatewayLifecycle.native.schema.ts";

const fixtures: Awaited<ReturnType<typeof publicationFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture() {
  const f = await publicationFixture({ ownerStartedAt: "start-v2:linux:fixture-boot:123" });
  fixtures.push(f);
  await f.run((publisher) => publisher.publish(f.request));
  const context = gatewayContext(f),
    state = f.read();
  if (state.schemaVersion !== 3) throw Error("Missing published fixture.");
  const release = state.mobile.releases[0]!;
  const original: MobileNativeGatewayOwnership = {
    binding: {
      authority: context.owner.authority.authorityId,
      installation: context.owner.installationFingerprint,
      nativeEpoch: context.binding.epoch,
      nonce: "native-attempt",
      publicationSha256: context.releaseId.slice(15),
      executableSha256: release.gateway.sha256,
      assetsSha256: release.assets.sha256,
      configurationSha256: "1".repeat(64),
      guardSha256: "2".repeat(64),
    },
    assetsReference: {
      schemaVersion: 1,
      generation: `assets-${"3".repeat(32)}`,
      sizeBytes: 1024,
      sha256: "4".repeat(64),
    },
    assetsArgument: "--assets-dir",
  };
  return { f, context, original };
}
function row(state: RemoteAgentRegistry) {
  if (state.schemaVersion !== 3 || !state.mobile.gatewayLifecycle)
    throw Error("Missing native lifecycle.");
  return state.mobile.gatewayLifecycle.attempts[0]!;
}
it("uses the existing CAS budget/pin, preserves metadata across P4 writes and reconciles lost ACK", async () => {
  const { f, context, original } = await fixture();
  const command = memoryRegistryCommand(f.read()),
    store = makeRemoteAgentRegistryStore("/tmp/native-registry", command);
  command.loseNextAck();
  const reserved = await store.update((s) =>
    reserveNativeMobileGatewayAttempt(s, context, original),
  );
  expect(row(reserved).nativeOwnership).toEqual(original);
  expect(reserved.pins).toContainEqual({
    owner: mobileGatewayBuildPin(original.binding.nonce),
    buildId: context.binding.buildId,
  });
  await store.update((s) => pinRemoteAgentBuild(s, "unrelated-client", context.binding.buildId));
  expect(row(await store.read()).nativeOwnership).toEqual(original);
  expect(reserveNativeMobileGatewayAttempt(reserved, context, original)).toBe(reserved);
  expect(() =>
    reserveNativeMobileGatewayAttempt(reserved, context, {
      ...original,
      assetsReference: { ...original.assetsReference, sha256: "5".repeat(64) },
    }),
  ).toThrow(/different/);
});
it("rejects foreign digests/epochs and prevents Node child/cancellation evidence on native rows", async () => {
  const { f, context, original } = await fixture();
  for (const binding of [
    { ...original.binding, nativeEpoch: "foreign" },
    { ...original.binding, assetsSha256: "5".repeat(64) },
  ])
    expect(() =>
      reserveNativeMobileGatewayAttempt(f.read(), context, { ...original, binding }),
    ).toThrow(/differs/);
  const reserved = reserveNativeMobileGatewayAttempt(f.read(), context, original);
  expect(() =>
    cancelUnlaunchedMobileGatewayAttempt(reserved, context, original.binding.nonce),
  ).toThrow(/refused/);
  const attempted = advanceMobileGatewayAttempt(
    reserved,
    context,
    original.binding.nonce,
    "attempted",
  );
  expect(() =>
    advanceMobileGatewayAttempt(attempted, context, original.binding.nonce, "child-owned", {
      pid: 1234,
      startedAt: "fake",
    }),
  ).toThrow(/native terminal/);
});
it("terminalizes only exact native identity after revocation/P4 rotation and retains unrelated references", async () => {
  const { f, context, original } = await fixture();
  let state = pinRemoteAgentBuild(f.read(), "unrelated-client", context.binding.buildId);
  state = reserveNativeMobileGatewayAttempt(state, context, original);
  state = advanceMobileGatewayAttempt(state, context, original.binding.nonce, "attempted");
  state = setRemoteAgentMobileConsent(
    state,
    { owner: context.owner, expectedConsentRevision: context.consentRevision },
    false,
  );
  state = parseRemoteAgentRegistry(
    JSON.stringify({
      ...state,
      revision: state.revision + 1,
      currentConnectionId: "rotated",
      admissions: [
        ...state.admissions,
        {
          id: "rotated",
          buildId: context.binding.buildId,
          phase: "ready",
          epoch: context.binding.epoch,
        },
      ],
    }),
  );
  const terminal = completeNativeMobileGatewayAttempt(
    state,
    context.owner,
    original,
    { kind: "native-cancel" },
    context.now - 1,
  );
  expect(row(terminal).phase).toBe("exit-confirmed");
  expect(terminal.pins).toEqual([{ owner: "unrelated-client", buildId: context.binding.buildId }]);
  expect(terminal.schemaVersion === 3 && terminal.mobile.gatewayLifecycle?.repairRequired).toBe(
    true,
  );
  expect(
    completeNativeMobileGatewayAttempt(
      terminal,
      context.owner,
      original,
      { kind: "native-cancel" },
      context.now,
    ),
  ).toBe(terminal);
  expect(() =>
    completeNativeMobileGatewayAttempt(
      terminal,
      context.owner,
      original,
      { kind: "native-never-invoked" },
      context.now,
    ),
  ).toThrow(/immutable/);
  expect(() =>
    completeNativeMobileGatewayAttempt(
      state,
      { ...context.owner, installationFingerprint: "sha256:" + "f".repeat(64) },
      original,
      { kind: "native-cancel" },
      context.now,
    ),
  ).toThrow(/authority/);
});
it("generic CAS refuses stripped/rewritten native ownership, nested future metadata and Node terminal substitution", async () => {
  const { f, context, original } = await fixture();
  const command = memoryRegistryCommand(f.read()),
    store = makeRemoteAgentRegistryStore("/tmp/native-registry", command);
  await store.update((s) => reserveNativeMobileGatewayAttempt(s, context, original));
  const state = await store.read();
  if (state.schemaVersion !== 3 || !state.mobile.gatewayLifecycle) throw Error("Missing fixture.");
  for (const attempt of [
    { ...row(state), nativeOwnership: undefined },
    { ...row(state), nativeOwnership: { ...original, assetsArgument: "--foreign" } },
  ]) {
    await expect(
      store.update((s) =>
        parseRemoteAgentRegistry(
          JSON.stringify({
            ...s,
            revision: s.revision + 1,
            mobile: {
              ...state.mobile,
              gatewayLifecycle: { ...state.mobile.gatewayLifecycle, attempts: [attempt] },
            },
          }),
        ),
      ),
    ).rejects.toThrow();
  }
  expect(() =>
    parseRemoteAgentRegistry(
      JSON.stringify({
        ...state,
        mobile: {
          ...state.mobile,
          gatewayLifecycle: {
            ...state.mobile.gatewayLifecycle,
            attempts: [{ ...row(state), nativeOwnership: { ...original, future: true } }],
          },
        },
      }),
    ),
  ).toThrow();
});
