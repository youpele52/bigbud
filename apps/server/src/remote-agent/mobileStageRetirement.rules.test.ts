// Fixture first: its supervisor-runner mock must precede every journal import.
import { retirementFixture } from "./mobileStageRetirement.test-fixture.ts";
import { expect, it } from "vitest";
import { classifyMobileActivationCause } from "../remote-backend/mobileGatewayActivation.reason.ts";
import { mobileGatewayBuildPin } from "./mobileGatewayLifecycle.transitions.ts";
import {
  MobileStageBudgetExhausted,
  mobileStageRetirementBlock,
  planMobileStageRetirement,
  retireMobileRegistryStages,
} from "./mobileStageRetirement.rules.ts";
import { assertMobileRegistryTransition } from "./remoteAgentInstall.mobile.invariants.ts";
import {
  MAX_MOBILE_REGISTRY_STAGES,
  type MobileRegistry,
} from "./remoteAgentInstall.mobile.schema.ts";
import { mobileFixture } from "./remoteAgentInstall.mobile.fixtures.ts";
import {
  reserveRemoteAgentMobileStage,
  setRemoteAgentMobileConsent,
} from "./remoteAgentInstall.mobile.transitions.ts";
import {
  emptyRemoteAgentRegistry,
  type RemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";

const v3 = (state: RemoteAgentRegistry) => {
  if (state.schemaVersion !== 3) throw Error("Missing mobile journal.");
  return state;
};
/** A forged CAS writer: same revision bump, arbitrary mobile edits. */
const forge = (state: RemoteAgentRegistry, edit: (mobile: MobileRegistry) => MobileRegistry) => {
  const before = v3(state);
  return { ...before, revision: before.revision + 1, mobile: edit(before.mobile) };
};
const transition = (before: RemoteAgentRegistry, next: RemoteAgentRegistry) => () =>
  assertMobileRegistryTransition(JSON.stringify(before), next);

it("refuses with a typed, guided reason only when 16 stages are genuinely live", () => {
  const f = mobileFixture();
  let state = setRemoteAgentMobileConsent(
    emptyRemoteAgentRegistry(),
    { ...f.context, expectedConsentRevision: 0 },
    true,
  );
  for (let index = 0; index < MAX_MOBILE_REGISTRY_STAGES; index++)
    state = reserveRemoteAgentMobileStage(state, f.context, { ...f.request, id: `live-${index}` });
  // All sixteen belong to the current consent revision: none is retirable.
  const plan = planMobileStageRetirement(v3(state).mobile, state.pins);
  expect(plan.retire).toEqual([]);
  expect([...plan.kept.values()]).toEqual(
    Array.from({ length: MAX_MOBILE_REGISTRY_STAGES }, () => "current-consent"),
  );
  expect(retireMobileRegistryStages(state, f.context.owner, new Set(["live-0"]))).toBe(state);
  let refusal: unknown;
  try {
    reserveRemoteAgentMobileStage(state, f.context, { ...f.request, id: "overflow" });
  } catch (cause) {
    refusal = cause;
  }
  expect(refusal).toBeInstanceOf(MobileStageBudgetExhausted);
  expect(String((refusal as Error).message)).toMatch(/bigbud mobile repair/);
  // Wrapped like the publisher's settled failure, it still classifies as the typed reason.
  expect(classifyMobileActivationCause({ _tag: "Wrapper", cause: refusal })).toBe(
    "stage-budget-exhausted",
  );
});

it("blocks a stage while a gateway base pin of its originals remains", async () => {
  const r = await retirementFixture();
  const first = await r.publish();
  await r.select(first);
  const original = await r.original(first);
  await r.settle(original);
  await r.regrant();
  await r.select(await r.publish());
  const state = v3(r.f.read());
  const stage = state.mobile.stages.find((s) => s.id === first)!;
  // The pin only goes with a recorded exit; forge it back to prove the evidence rule.
  const pins = [{ owner: mobileGatewayBuildPin(original.binding.nonce), buildId: "b" }];
  expect(mobileStageRetirementBlock(state.mobile, pins, stage)).toBe("pinned");
  expect(mobileStageRetirementBlock(state.mobile, state.pins, stage)).toBeNull();
  expect(
    transition(
      { ...state, pins },
      forge({ ...state, pins }, (mobile) => ({
        ...mobile,
        stages: mobile.stages.filter((s) => s.id !== first),
        retired: { stages: 1, revisionFloor: stage.consentRevision, selections: 0, attempts: 0 },
      })),
    ),
  ).toThrow();
});

it("generic CAS writers cannot discard live stages, rows or the tally", async () => {
  const r = await retirementFixture();
  const first = await r.publish();
  await r.select(first);
  await r.settle(await r.original(first));
  await r.regrant();
  const second = await r.publish();
  await r.select(second);
  await r.regrant();
  const state = v3(r.f.read());
  const drop = (id: string, tally: Partial<NonNullable<MobileRegistry["retired"]>> = {}) =>
    forge(state, (mobile) => ({
      ...mobile,
      stages: mobile.stages.filter((s) => s.id !== id),
      retired: { stages: 1, revisionFloor: 3, selections: 0, attempts: 0, ...tally },
    }));
  // The desired stage, and a settled stage whose rows would stay behind (untallied).
  expect(transition(state, drop(second))).toThrow();
  expect(transition(state, drop(first))).toThrow();
  // The legitimate retirement passes the same invariant, then the tally cannot be reset.
  const retired = retireMobileRegistryStages(state, r.f.pin, new Set([first, second]));
  expect(v3(retired).mobile.stages.map((s) => s.id)).toEqual([second]);
  expect(transition(state, retired)).not.toThrow();
  expect(
    transition(
      retired,
      forge(retired, ({ retired: _tally, ...mobile }) => mobile),
    ),
  ).toThrow();
  // Dropping a settled attempt without retiring its stage is refused.
  const settledOnly = forge(state, (mobile) => ({
    ...mobile,
    gatewayLifecycle: { ...mobile.gatewayLifecycle!, attempts: [] },
    retired: { stages: 0, revisionFloor: 0, selections: 0, attempts: 1 },
  }));
  expect(transition(state, settledOnly)).toThrow();
});
