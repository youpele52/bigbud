import { publicationFixture } from "./mobileOptionalPublication.test-fixtures.ts";
import { gatewayContext } from "./mobileGatewayLifecycle.test-fixtures.ts";
import { reserveMobileGatewayAttempt } from "./mobileGatewayLifecycle.transitions.ts";
import { expect, it } from "vitest";
import {
  emptyRemoteAgentRegistry,
  parseRemoteAgentRegistry,
  type RemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";
import { mobileFixture, memoryRegistryCommand } from "./remoteAgentInstall.mobile.fixtures.ts";
import {
  reserveRemoteAgentMobileStage,
  setRemoteAgentMobileConsent,
} from "./remoteAgentInstall.mobile.transitions.ts";
import { makeRemoteAgentRegistryStore } from "./remoteAgentInstall.registry.store.ts";
import { nextRemoteAgentRegistryRevision } from "./remoteAgentAdmission.types.ts";
import {
  selectMobileGatewayDesired,
  findMobileGatewaySelection,
  type MobileGatewaySelectionContext,
} from "./mobileGatewayActivation.selection.transitions.ts";

const requestId = (index: number) =>
  `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
const configuration = { externalOrigin: "https://fixture.example", port: 47320 };
function fixture() {
  const f = mobileFixture();
  const enabled = setRemoteAgentMobileConsent(
    emptyRemoteAgentRegistry(),
    { ...f.context, expectedConsentRevision: 0 },
    true,
  );
  const reserved = reserveRemoteAgentMobileStage(enabled, f.context, f.request);
  if (reserved.schemaVersion !== 3) throw Error("Expected fixture v3.");
  const stage = reserved.mobile.stages[0]!;
  const identity = { dev: "1", ino: "2" };
  const file = { ...identity, mtimeNs: "3", ctimeNs: "4" };
  // Structural CAS fixture only: no filesystem publication proof is minted here.
  const state = parseRemoteAgentRegistry(
    JSON.stringify({
      ...reserved,
      mobile: {
        ...reserved.mobile,
        stages: [
          {
            ...stage,
            phase: "files-published",
            publicationIntent: {
              key: "a".repeat(64),
              root: identity,
              namespace: identity,
              directory: identity,
            },
            publicationReceipt: {
              directoryMtimeNs: "3",
              directoryCtimeNs: "4",
              gateway: file,
              assets: file,
            },
          },
        ],
      },
    }),
  );
  return { state, context: { ...f.context, stageId: stage.id, releaseId: stage.releaseId } };
}
function select(state: RemoteAgentRegistry, context: MobileGatewaySelectionContext, index: number) {
  return selectMobileGatewayDesired(state, context, { requestId: requestId(index), configuration });
}

it("joins the exact current request and retires historical requests without relaunch", () => {
  const f = fixture(),
    first = select(f.state, f.context, 1),
    second = select(first, f.context, 2);
  expect(select(first, f.context, 1)).toBe(first);
  expect(findMobileGatewaySelection(second, requestId(1))?.retired).toBe(true);
  expect(() => select(second, f.context, 1)).toThrow(/Retired/);
  expect(() =>
    selectMobileGatewayDesired(first, f.context, {
      requestId: requestId(1),
      configuration: { ...configuration, port: 47321 },
    }),
  ).toThrow(/another immutable tuple/);
});
it("bounds immutable current and retired request identities to sixteen", () => {
  const f = fixture();
  let state = f.state;
  for (let index = 1; index <= 16; index++) state = select(state, f.context, index);
  expect(() => select(state, f.context, 17)).toThrow(/budget/);
  if (state.schemaVersion !== 3) throw Error("Expected fixture v3.");
  expect(state.mobile.desired?.revision).toBe(16);
  expect(state.mobile.desiredHistory).toHaveLength(15);
});
it("retains selection through consent revoke and fences setting-only resurrection", () => {
  const f = fixture(),
    state = select(f.state, f.context, 1);
  const off = setRemoteAgentMobileConsent(state, f.context, false);
  if (off.schemaVersion !== 3 || state.schemaVersion !== 3) throw Error("Expected fixture v3.");
  expect(off.mobile.desired).toEqual(state.mobile.desired);
  expect(off.mobile.desired?.consentRevision).toBe(1);
  expect(off.mobile.consent).toEqual({ enabled: false, revision: 2 });
  expect(() => select(off, f.context, 2)).toThrow(/separate consent/);
});
it("generic P4 revision writes preserve selection and reject future nested fields", () => {
  const f = fixture(),
    state = select(f.state, f.context, 1);
  const next = nextRemoteAgentRegistryRevision(state, { pins: [] });
  if (state.schemaVersion !== 3 || next.schemaVersion !== 3) throw Error("Expected fixture v3.");
  expect(next.mobile).toEqual(state.mobile);
  expect(() =>
    parseRemoteAgentRegistry(
      JSON.stringify({
        ...state,
        mobile: { ...state.mobile, desired: { ...state.mobile.desired, nativeReady: true } },
      }),
    ),
  ).toThrow();
});
it("generic CAS cannot mutate or discard the exact append-only replay history", async () => {
  const f = fixture(),
    initial = select(select(f.state, f.context, 1), f.context, 2);
  const store = makeRemoteAgentRegistryStore("/tmp/agent", memoryRegistryCommand(initial));
  await expect(
    store.update((state) => {
      if (state.schemaVersion !== 3) throw Error("Expected fixture v3.");
      return {
        ...state,
        revision: state.revision + 1,
        mobile: { ...state.mobile, desiredHistory: [] },
      };
    }),
  ).rejects.toThrow();
  await expect(
    store.update((state) => {
      if (state.schemaVersion !== 3 || !state.mobile.desired)
        throw Error("Expected desired selection.");
      return {
        ...state,
        revision: state.revision + 1,
        mobile: {
          ...state.mobile,
          desired: { ...state.mobile.desired, configuration: { ...configuration, port: 47322 } },
        },
      };
    }),
  ).rejects.toThrow(/Desired replacement/);
  expect(await store.read()).toEqual(initial);
});
it("generic CAS supports one exact replacement and rejects request reuse with new content", async () => {
  const f = fixture(),
    first = select(f.state, f.context, 1);
  const store = makeRemoteAgentRegistryStore("/tmp/agent", memoryRegistryCommand(first));
  const second = await store.update((state) => select(state, f.context, 2));
  if (second.schemaVersion !== 3 || first.schemaVersion !== 3) throw Error("Expected fixture v3.");
  expect(second.mobile.desiredHistory).toEqual([first.mobile.desired]);
  await expect(
    store.update((state) => {
      if (state.schemaVersion !== 3 || !state.mobile.desired)
        throw Error("Expected desired selection.");
      return {
        ...state,
        revision: state.revision + 1,
        mobile: {
          ...state.mobile,
          desired: { ...state.mobile.desired, requestId: requestId(1), revision: 3 },
          desiredHistory: [...state.mobile.desiredHistory!, state.mobile.desired],
        },
      };
    }),
  ).rejects.toThrow();
});

it("rejects stale consent, foreign owner and unpublished component selection", () => {
  const f = fixture();
  expect(() => select(f.state, { ...f.context, expectedConsentRevision: 2 }, 1)).toThrow(/consent/);
  expect(() =>
    select(
      f.state,
      {
        ...f.context,
        owner: { ...f.context.owner, installationFingerprint: "sha256:" + "f".repeat(64) },
      },
      1,
    ),
  ).toThrow(/actual owner/);
  if (f.state.schemaVersion !== 3) throw Error("Expected fixture v3.");
  const unpublished = parseRemoteAgentRegistry(
    JSON.stringify({
      ...f.state,
      mobile: {
        ...f.state.mobile,
        stages: f.state.mobile.stages.map((stage) => ({ ...stage, phase: "cancelled" })),
      },
    }),
  );
  expect(() => select(unpublished, f.context, 1)).toThrow(/published component/);
});
it("captures desired replay fences before callback mutation", async () => {
  const f = fixture(),
    initial = select(f.state, f.context, 1);
  const store = makeRemoteAgentRegistryStore("/tmp/agent", memoryRegistryCommand(initial));
  await expect(
    store.update((state) => {
      if (state.schemaVersion !== 3 || !state.mobile.desired)
        throw Error("Expected desired selection.");
      Object.defineProperty(state.mobile.desired, "configuration", {
        value: { ...configuration, port: 47323 },
      });
      return { ...state, revision: state.revision + 1 };
    }),
  ).rejects.toThrow(/Desired replacement/);
  expect(await store.read()).toEqual(initial);
});

it("generic writers cannot replace desired selection while a launch is unresolved", async () => {
  const f = await publicationFixture();
  try {
    await f.run((publisher) => publisher.publish(f.request));
    const published = f.read();
    if (published.schemaVersion !== 3) throw Error("Expected fixture v3.");
    const stage = published.mobile.stages[0]!;
    const context = {
      owner: f.pin,
      expectedConsentRevision: 1,
      stageId: stage.id,
      releaseId: stage.releaseId,
    };
    const first = select(published, context, 1),
      second = select(first, context, 2);
    if (second.schemaVersion !== 3) throw Error("Expected fixture v3.");
    f.replaceState(first);
    const pending = reserveMobileGatewayAttempt(
      first,
      gatewayContext(f),
      "unresolved-selector-attempt",
    );
    expect(() => select(pending, context, 2)).toThrow(/uncertain ownership/);
    const store = makeRemoteAgentRegistryStore(f.control.root, memoryRegistryCommand(pending));
    await expect(
      store.update((state) => {
        if (state.schemaVersion !== 3) throw Error("Expected fixture v3.");
        return {
          ...state,
          revision: state.revision + 1,
          mobile: {
            ...state.mobile,
            desired: second.mobile.desired,
            desiredHistory: second.mobile.desiredHistory,
          },
        };
      }),
    ).rejects.toThrow(/settled children/);
    expect(await store.read()).toEqual(pending);
  } finally {
    await f.close();
  }
});
