import * as Effect from "effect/Effect";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { expect, it } from "vitest";
import { V2ActivationGate } from "./PluginSetup.activation.gate.ts";
import { settleV2PreparedReservation, settleV2RuntimeReservation } from "./Runtime.activation.ts";
import { V2RuntimeMutations } from "./Runtime.mutations.ts";
import type { V2IsolatedRuntimeOptions, V2RuntimeSession } from "./Runtime.types.ts";
import { deferred } from "./Test.fixtures.ts";
import { withV2SettlementFixture } from "./Runtime.settlement.fixture.ts";

it.each([false, true])(
  "failed pre-enrollment startup releases only verified physical creation (underlying SDK pending=%s)",
  async (pending) => {
    const gate = new V2ActivationGate("owned-scope", "A", () => {}),
      stamp = gate.verify("/owned", "A", "instance"),
      token = gate.tryReserve(stamp, "startup")!;
    const sdk = deferred<void>(),
      physical = gate.dispatch(token, () => sdk.promise);
    if (!pending) {
      sdk.resolve();
      await physical;
    }
    const activation: NonNullable<V2RuntimeSession["activation"]> = {
      gate,
      stamp,
      token,
      phase: "startup",
    };
    const options = {
      config: { sharedService: {} },
      journal: { listBoundPage: () => Effect.succeed([]) },
      sharedBindings: {
        find: () =>
          Effect.succeed({
            state: "verified",
            nativeSessionId: "native",
            storageIdentity: "storage",
            directory: "/owned",
          }),
      },
    } as unknown as V2IsolatedRuntimeOptions;
    const created = {
      activation,
      threadId: ThreadId.makeUnsafe("thread"),
      storageIdentity: "storage",
      native: { id: "native", location: { directory: "/owned" } },
      lease: { process: { client: { session: { active: async () => ({}) } } } },
    } as unknown as Parameters<typeof settleV2PreparedReservation>[1];
    try {
      await settleV2PreparedReservation(options, created, new V2RuntimeMutations());
      expect(gate.busyCount()).toBe(pending ? 1 : 0);
      expect(activation.phase).toBe(pending ? "uncertain" : "settled");
    } finally {
      sdk.resolve();
      await physical;
    }
  },
);

it.each([
  "admission-in-flight",
  "final-events",
  "final-publication-pending",
  "pending-interactions",
  "row-not-terminal",
] as const)(
  "a drained terminal owner reports hold %s and keeps its reservation",
  async (reason) => {
    await withV2SettlementFixture(async (f) => {
      await f.send("first");
      f.setActive(false);
      const token = f.owner.activation!.token!;
      const row = f.owner.row;
      if (reason === "admission-in-flight") f.owner.admissionInFlight = true;
      if (reason === "final-events") f.owner.finalEvents = [{} as never];
      if (reason === "final-publication-pending")
        f.owner.finalPublication = { eventId: "e", operation: Promise.resolve(), state: "pending" };
      if (reason === "pending-interactions")
        f.owner.pendingInteractions = new Map([["p", {} as never]]);
      if (reason === "row-not-terminal") f.owner.terminalDelivered = false;
      try {
        expect(await settleV2RuntimeReservation(f.runtime, f.owner)).toBe(reason);
        expect(f.owner.activation?.token).toBe(token);
        expect(f.gate.busyCount()).toBe(1);
      } finally {
        delete f.owner.admissionInFlight;
        delete f.owner.finalEvents;
        delete f.owner.finalPublication;
        delete f.owner.pendingInteractions;
        f.owner.terminalDelivered = true;
        f.owner.row = row;
      }
      expect(await settleV2RuntimeReservation(f.runtime, f.owner)).toBeUndefined();
      expect(f.owner.activation?.token).toBeUndefined();
    });
  },
);
