import { expect, it, vi } from "vitest";
import { withV2SettlementFixture } from "./Runtime.settlement.fixture.ts";
import { settleV2RuntimeReservation } from "./Runtime.activation.ts";
import { repairV2RetainedReservation } from "./Runtime.settlement.ts";
import { nextV2SettlementSequence, V2ActiveExecutions } from "./Execution.owners.ts";
import { reconcileV2BridgeExecutions } from "./Orchestration.bridge.activation.ts";
import { v2OrchestrationInvocationId } from "./Execution.orchestration.ts";
import { enterThreadToolInvocation } from "../../../orchestration-tools/threadToolInvocationFlights.ts";

type Fixture = Parameters<Parameters<typeof withV2SettlementFixture>[0]>[0];
type DurableState = Awaited<
  ReturnType<Parameters<typeof reconcileV2BridgeExecutions>[3]["durableState"]>
>;

/** Reproduces attempt 5: a thread-tool callback dispatched, then its guard threw (RangeError cycle). */
async function failDispatchedCallback(
  f: Fixture,
  durableState?: () => Promise<DurableState>,
): Promise<V2ActiveExecutions> {
  const active = new V2ActiveExecutions(),
    controller = new AbortController();
  await expect(
    active.run(controller, () =>
      active.dispatch(
        controller,
        async () => {
          throw new RangeError("Maximum call stack size exceeded");
        },
        "receipt-key",
      ),
    ),
  ).rejects.toThrow(RangeError);
  f.owner.coding = {
    pending: () => [],
    revoke: () => {},
    cancelActive: async () => {},
    busyCount: () => active.busyCount(),
    ...(durableState
      ? {
          reconcile: () =>
            reconcileV2BridgeExecutions(f.runtime, f.owner, active, { durableState }),
        }
      : {}),
  };
  return active;
}

const prompts = (f: Fixture) =>
  f.http.calls.filter((call) => call.pathname.endsWith("/prompt")).length;

it("H1 red: a failed dispatched callback holds settlement as coding-busy and the next send names it", async () => {
  await withV2SettlementFixture(async (f) => {
    await f.send("first");
    f.setActive(false);
    const active = await failDispatchedCallback(f);
    try {
      expect(active.busyCount()).toBe(1);
      expect(await settleV2RuntimeReservation(f.runtime, f.owner)).toBe("coding-busy");
      await expect(f.send("blocked")).rejects.toThrow(
        "V2 prior physical admission remains owned (hold: coding-busy); no new turn.",
      );
      // No timer, retry or repeated settlement manufactures idle without proof.
      for (let i = 0; i < 3; i++)
        expect(await settleV2RuntimeReservation(f.runtime, f.owner)).toBe("coding-busy");
      expect(f.owner.activation?.token).toBeDefined();
      expect(prompts(f)).toBe(1);
    } finally {
      delete f.owner.coding;
    }
  });
});

it("H1 fix: native drain plus a durable receipt reconciles the uncertain callback and admits the next send", async () => {
  await withV2SettlementFixture(async (f) => {
    await f.send("first");
    const durableState = vi.fn(async (): Promise<DurableState> => "reserved");
    const active = await failDispatchedCallback(f, durableState);
    try {
      // Native still active: the receipt alone is not proof.
      expect(await settleV2RuntimeReservation(f.runtime, f.owner)).toBe("coding-busy");
      expect(active.busyCount()).toBe(1);
      f.setActive(false);
      expect(await settleV2RuntimeReservation(f.runtime, f.owner)).toBeUndefined();
      expect(durableState).toHaveBeenCalledWith("receipt-key");
      expect(active.busyCount()).toBe(0);
      expect(f.owner.activation?.token).toBeUndefined();
      await f.send("second");
      expect(prompts(f)).toBe(2);
    } finally {
      delete f.owner.coding;
    }
  });
});

it.each(["unreadable receipt", "interrupt acknowledged"] as const)(
  "H1 fix: %s decides reconciliation without manufacturing idle",
  async (scenario) => {
    await withV2SettlementFixture(async (f) => {
      await f.send("first");
      f.setActive(false);
      const active = await failDispatchedCallback(f, async () => {
        throw new Error("fixture receipt store unreadable");
      });
      try {
        expect(await settleV2RuntimeReservation(f.runtime, f.owner)).toBe("coding-busy");
        if (scenario === "interrupt acknowledged") {
          f.owner.interruptAcknowledgedSequence = nextV2SettlementSequence();
          expect(await settleV2RuntimeReservation(f.runtime, f.owner)).toBeUndefined();
          expect(active.busyCount()).toBe(0);
        } else {
          expect(active.busyCount()).toBe(1);
          expect(f.owner.activation?.token).toBeDefined();
        }
      } finally {
        delete f.owner.coding;
      }
    });
  },
);

it("a failed drain read during reconciliation keeps the callback held and reports coding-busy", async () => {
  await withV2SettlementFixture(async (f) => {
    await f.send("first");
    f.setActive(false);
    const durableState = vi.fn(async (): Promise<DurableState> => "completed");
    const active = await failDispatchedCallback(f, durableState);
    const read = vi
      .spyOn(f.http.client.session, "active")
      .mockRejectedValue(new Error("fixture drain read failed"));
    try {
      expect(await settleV2RuntimeReservation(f.runtime, f.owner)).toBe("coding-busy");
      expect(durableState).not.toHaveBeenCalled();
      expect(active.busyCount()).toBe(1);
      expect(f.owner.activation?.token).toBeDefined();
    } finally {
      read.mockRestore();
      delete f.owner.coding;
    }
  });
});

it("an interrupt acknowledged before the failure is not proof for that later failure", async () => {
  await withV2SettlementFixture(async (f) => {
    await f.send("first");
    f.setActive(false);
    f.owner.interruptAcknowledgedSequence = nextV2SettlementSequence();
    const active = await failDispatchedCallback(f, async () => {
      throw new Error("fixture receipt store unreadable");
    });
    try {
      expect(await settleV2RuntimeReservation(f.runtime, f.owner)).toBe("coding-busy");
      expect(active.busyCount()).toBe(1);
    } finally {
      delete f.owner.coding;
      delete f.owner.interruptAcknowledgedSequence;
    }
  });
});

it.each([
  ["reserved receipt with its canonical handler still in flight", "reserved", true, "coding-busy"],
  ["reserved receipt whose canonical handler has finished", "reserved", false, undefined],
  ["absent receipt", "absent", false, undefined],
  ["terminal receipt", "completed", false, undefined],
] as const)("H1 in-flight evidence: %s", async (_label, state, handlerInFlight, expected) => {
  await withV2SettlementFixture(async (f) => {
    await f.send("first");
    f.setActive(false);
    // The real in-process route ledger: the bigbud handler outlived the caller's request timeout.
    const leave = handlerInFlight
      ? enterThreadToolInvocation(v2OrchestrationInvocationId("receipt-key"))
      : undefined;
    const active = await failDispatchedCallback(f, async () => state);
    try {
      expect(await settleV2RuntimeReservation(f.runtime, f.owner)).toBe(expected);
      expect(active.busyCount()).toBe(expected ? 1 : 0);
      if (leave) {
        expect(f.owner.activation?.token).toBeDefined();
        leave(); // Only the handler's real end releases; no timer participates.
        expect(await settleV2RuntimeReservation(f.runtime, f.owner)).toBeUndefined();
        expect(active.busyCount()).toBe(0);
      }
    } finally {
      leave?.();
      delete f.owner.coding;
    }
  });
});

it("the 30-second retained-settlement status carries the last hold reason", async () => {
  await withV2SettlementFixture(async (f) => {
    await f.send("first");
    f.setActive(false);
    await failDispatchedCallback(f);
    await repairV2RetainedReservation(f.runtime, f.owner);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31000);
    try {
      await repairV2RetainedReservation(f.runtime, f.owner);
      const errors = f.events.filter(
        (e) => e.type === "session.state.changed" && e.payload.state === "error",
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]?.payload).toMatchObject({
        reason: expect.stringContaining("(hold: coding-busy)"),
      });
      expect(f.owner.session.lastError).toContain("(hold: coding-busy)");
    } finally {
      clock.mockRestore();
      delete f.owner.coding;
    }
  });
});
