import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { withV2SettlementFixture } from "./Runtime.settlement.fixture.ts";
import { v2BridgeRetirementProof } from "./Orchestration.bridge.activation.ts";
import { V2ActiveExecutions } from "./Execution.owners.ts";

it.each(["reserved", "active", "intent"] as const)(
  "retirement distinguishes drained reservation from %s",
  async (state) => {
    await withV2SettlementFixture(async ({ runtime, owner, http, send, setActive }) => {
      vi.spyOn(http.client.session.instructions.entry, "list").mockRejectedValueOnce(
        new Error("preparation failed"),
      );
      await expect(send("retirement-reservation")).rejects.toMatchObject({
        _tag: "V2PreparationFailed",
      });
      if (state === "intent")
        await Effect.runPromise(
          runtime.options.journal.transition(
            owner.row!,
            "dispatch-intent",
            new Date().toISOString(),
          ),
        );
      if (state === "active") setActive(true);
      try {
        const proof = await v2BridgeRetirementProof(
          runtime,
          owner,
          new V2ActiveExecutions(),
          {
            retirementEvidence: async () => ({ receiptsSettled: true }),
          },
          true,
        );
        expect(proof.admissionsSettled).toBe(state === "reserved");
        expect(owner.row?.state).toBe("reserved");
        expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(0);
      } finally {
        setActive(false);
      }
    });
  },
);
