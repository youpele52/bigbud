import { expect, it } from "vitest";
import {
  emptyRemoteAgentRegistry,
  type RemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";
import { makeRemoteAgentRegistryStore } from "./remoteAgentInstall.registry.store.ts";
import { memoryRegistryCommand, mobileFixture } from "./remoteAgentInstall.mobile.fixtures.ts";
import {
  reserveRemoteAgentMobileStage,
  setRemoteAgentMobileConsent,
} from "./remoteAgentInstall.mobile.transitions.ts";

type V3 = Extract<RemoteAgentRegistry, { schemaVersion: 3 }>;
function requireV3(state: RemoteAgentRegistry): V3 {
  if (state.schemaVersion !== 3) throw new Error("Expected fixture v3.");
  return state;
}
async function rejectsGenericWrite(
  transition: (state: V3) => RemoteAgentRegistry,
  reserved = false,
) {
  const f = mobileFixture();
  let initial = setRemoteAgentMobileConsent(
    emptyRemoteAgentRegistry(),
    { ...f.context, expectedConsentRevision: 0 },
    true,
  );
  if (reserved) initial = reserveRemoteAgentMobileStage(initial, f.context, f.request);
  const command = memoryRegistryCommand(initial);
  const store = makeRemoteAgentRegistryStore("/tmp/agent", command);
  await expect(store.update((state) => transition(requireV3(state)))).rejects.toThrow();
  expect(await store.read()).toEqual(initial);
}

it("generic CAS cannot downgrade v3 to v2 and discard mobile state", async () => {
  await rejectsGenericWrite((state) => {
    const { mobile: _mobile, ...base } = state;
    return { ...base, schemaVersion: 2, revision: state.revision + 1 };
  });
});
it("generic CAS cannot replace authority/installation pins", async () => {
  await rejectsGenericWrite((state) => ({
    ...state,
    revision: state.revision + 1,
    mobile: {
      ...state.mobile,
      owner: { ...state.mobile.owner, installationFingerprint: "sha256:" + "f".repeat(64) },
    },
  }));
});
it("generic CAS cannot change enabled consent without advancing its revision", async () => {
  await rejectsGenericWrite((state) => ({
    ...state,
    revision: state.revision + 1,
    mobile: {
      ...state.mobile,
      consent: { ...state.mobile.consent, enabled: false },
    },
  }));
});
it("generic CAS cannot jump the consent revision to bypass attempt fencing", async () => {
  await rejectsGenericWrite((state) => ({
    ...state,
    revision: state.revision + 1,
    mobile: {
      ...state.mobile,
      consent: { ...state.mobile.consent, revision: state.mobile.consent.revision + 2 },
    },
  }));
});
it("captures immutable primitives before an in-place owner mutation with a new return object", async () => {
  await rejectsGenericWrite((state) => {
    (state.mobile.owner.authority as { keyEpoch: number }).keyEpoch = 2;
    return { ...state, revision: state.revision + 1 };
  });
});
it("rejects in-place owner mutation even when callback returns the same object", async () => {
  await rejectsGenericWrite((state) => {
    (state.mobile.owner.authority as { keyEpoch: number }).keyEpoch = 2;
    return state;
  });
});
it("captures global revision before callback mutation", async () => {
  await rejectsGenericWrite((state) => {
    (state as { revision: number }).revision += 100;
    return { ...state, revision: state.revision + 1 };
  });
});
it("does not permit generic writers to delete pending replay fences", async () => {
  await rejectsGenericWrite(
    (state) => ({
      ...state,
      revision: state.revision + 1,
      mobile: { ...state.mobile, stages: [], releases: [] },
    }),
    true,
  );
});

it("generic CAS cannot roll consent back to an earlier enabled revision", async () => {
  const f = mobileFixture();
  const first = setRemoteAgentMobileConsent(
    emptyRemoteAgentRegistry(),
    { ...f.context, expectedConsentRevision: 0 },
    true,
  );
  const revoked = setRemoteAgentMobileConsent(first, f.context, false);
  const current = setRemoteAgentMobileConsent(
    revoked,
    { ...f.context, expectedConsentRevision: 2 },
    true,
  );
  const store = makeRemoteAgentRegistryStore("/tmp/agent", memoryRegistryCommand(current));
  await expect(
    store.update((before) => {
      const state = requireV3(before);
      return {
        ...state,
        revision: state.revision + 1,
        mobile: { ...state.mobile, consent: { revision: 1, enabled: true } },
      };
    }),
  ).rejects.toThrow(/monotonically/);
  expect(await store.read()).toEqual(current);
});
