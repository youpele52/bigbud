import { expect, it } from "vitest";
import { fixture, row } from "../remote-agent/mobileGatewayLifecycle.native.transitions.fixture.ts";
import { reserveNativeMobileGatewayAttempt } from "../remote-agent/mobileGatewayLifecycle.native.transitions.ts";
import {
  advanceMobileGatewayAttempt,
  mobileGatewayBuildPin,
} from "../remote-agent/mobileGatewayLifecycle.transitions.ts";
import { makeRemoteAgentRegistryStore } from "../remote-agent/remoteAgentInstall.registry.store.ts";
import { memoryRegistryCommand } from "../remote-agent/remoteAgentInstall.mobile.fixtures.ts";
import { parseRemoteAgentRegistry } from "../remote-agent/remoteAgentInstall.registry.ts";
import { mobileRuntimeOrphanProof } from "./mobileGatewayAssets.orphan.proof.ts";
import {
  attemptedNativeMobileRows,
  nativeMobileEpochEndedProof,
  resolveEndedNativeMobileAttempts,
} from "./mobileGatewayNative.resolve.ts";

async function attempted(restartPhase?: "starting" | "ready" | "stopping" | "failed") {
  const { f, context, original } = await fixture();
  let state = reserveNativeMobileGatewayAttempt(f.read(), context, original);
  state = advanceMobileGatewayAttempt(state, context, original.binding.nonce, "attempted");
  if (restartPhase)
    state = parseRemoteAgentRegistry(
      JSON.stringify({
        ...state,
        restartReservations: [
          {
            id: "boot-restart",
            buildId: context.binding.buildId,
            generation: "g",
            expectedEpoch: context.binding.epoch,
            phase: restartPhase,
          },
        ],
      }),
    );
  const command = memoryRegistryCommand(state);
  const store = makeRemoteAgentRegistryStore("/tmp/native-registry", command);
  return { context, original, store, state, attempt: attemptedNativeMobileRows(state)[0]! };
}
const sameBoot = "fixture-boot";

it("never proves a live epoch, nor a death without a reboot or settled exit receipt", async () => {
  const live = await attempted("ready");
  const epoch = live.context.binding.epoch;
  expect(nativeMobileEpochEndedProof(live.state, live.attempt, { epoch, bootId: "x" })).toEqual({
    kind: "kept",
    reason: "live-epoch",
  });
  for (const phase of [undefined, "stopping", "failed"] as const) {
    const unproven = await attempted(phase);
    expect(
      nativeMobileEpochEndedProof(unproven.state, unproven.attempt, {
        epoch: "replacement",
        bootId: sameBoot,
      }),
    ).toEqual({ kind: "kept", reason: "death-unproven" });
  }
});

it("proves a prior boot or a settled supervisor exit of exactly that epoch", async () => {
  const reboot = await attempted();
  expect(
    nativeMobileEpochEndedProof(reboot.state, reboot.attempt, { epoch: null, bootId: "later" }),
  ).toEqual({ kind: "proven", proof: "prior-boot" });
  for (const phase of ["starting", "ready"] as const) {
    const settled = await attempted(phase);
    expect(
      nativeMobileEpochEndedProof(settled.state, settled.attempt, {
        epoch: "replacement",
        bootId: sameBoot,
      }),
    ).toEqual({ kind: "proven", proof: "settled-supervisor-exit" });
  }
});

it("settles a proven row by CAS, releases its pin and lets the orphan GC prove the tree", async () => {
  const { context, original, store } = await attempted("ready");
  const host = { epoch: "replacement", bootId: sameBoot };
  const report = await resolveEndedNativeMobileAttempts(
    { pin: context.owner, registry: () => store },
    host,
    new AbortController().signal,
  );
  expect(report).toEqual({
    cleared: 1,
    kept: 0,
    unresolved: 0,
    entries: [
      {
        generation: original.assetsReference.generation,
        outcome: "cleared",
        reason: "settled-supervisor-exit",
      },
    ],
  });
  const after = await store.read();
  expect(row(after)).toMatchObject({
    phase: "exit-confirmed",
    completionEvidence: {
      kind: "native-epoch-ended",
      epoch: context.binding.epoch,
      proof: "settled-supervisor-exit",
    },
  });
  expect(after.pins.some((p) => p.owner === mobileGatewayBuildPin(original.binding.nonce))).toBe(
    false,
  );
  expect(
    mobileRuntimeOrphanProof(after, context.owner, original.assetsReference.generation).kind,
  ).toBe("proven");
});

it("keeps an unproven row untouched and reports it", async () => {
  const { context, original, store } = await attempted();
  const report = await resolveEndedNativeMobileAttempts(
    { pin: context.owner, registry: () => store },
    { epoch: "replacement", bootId: sameBoot },
    new AbortController().signal,
  );
  expect(report.entries).toEqual([
    {
      generation: original.assetsReference.generation,
      outcome: "kept",
      reason: "death-unproven",
    },
  ]);
  expect(report.unresolved).toBe(1);
  expect(row(await store.read()).phase).toBe("attempted");
});
