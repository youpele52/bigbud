import { expect, it, vi } from "vitest";
import { shouldPollV2Runtime, repairV2RetainedReservation } from "./Runtime.settlement.ts";
import { withV2SettlementFixture } from "./Runtime.settlement.fixture.ts";

it("backs off retained terminal owners, never enqueues parallel repairs, and resets for a new token", async () => {
  await withV2SettlementFixture(async (f) => {
    await f.send("first");
    const now = Date.now();
    const attempts = [];
    for (let elapsed = 0; elapsed <= 120000; elapsed += 100)
      if (shouldPollV2Runtime(f.owner, now + elapsed)) attempts.push(elapsed);
    expect(attempts).toEqual([0, 1000, 3000, 7000, 15000, 31000, 61000, 91000]);
    f.owner.repairQueued = true;
    expect(shouldPollV2Runtime(f.owner, now + 150000)).toBe(false);
    f.owner.repairQueued = false;
    f.owner.stopped = true;
    expect(shouldPollV2Runtime(f.owner, now + 150000)).toBe(false);
    f.owner.stopped = false;
    f.setActive(false);
    await f.send("second");
    expect(shouldPollV2Runtime(f.owner, now)).toBe(true);
  });
});

it.each([false, true])(
  "reports prolonged pending settlement once and restores readiness only after verified drain (read fails=%s)",
  async (readFails) => {
    await withV2SettlementFixture(async (f) => {
      await f.send("first");
      await repairV2RetainedReservation(f.runtime, f.owner);
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31000);
      const read = readFails
        ? vi
            .spyOn(f.http.client.session, "active")
            .mockRejectedValue(new Error("fixture read failed"))
        : undefined;
      try {
        for (let i = 0; i < 2; i++) {
          const result = repairV2RetainedReservation(f.runtime, f.owner);
          if (readFails) await expect(result).rejects.toThrow("drain failed or timed out");
          else await result;
        }
        expect(f.owner.session.status).toBe("error");
        expect(
          f.events.filter((e) => e.type === "session.state.changed" && e.payload.state === "error"),
        ).toHaveLength(1);
        expect(f.owner.activation?.token).toBeDefined();
        read?.mockRestore();
        f.setActive(false);
        await repairV2RetainedReservation(f.runtime, f.owner);
        expect(f.owner.session.status).toBe("ready");
        expect(f.owner.activation?.token).toBeUndefined();
        expect(f.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
      } finally {
        read?.mockRestore();
        clock.mockRestore();
      }
    });
  },
);
