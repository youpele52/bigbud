import { expect, it } from "vitest";
import { fixture, row } from "./mobileGatewayLifecycle.native.transitions.fixture.ts";
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
import { parseRemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";

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
