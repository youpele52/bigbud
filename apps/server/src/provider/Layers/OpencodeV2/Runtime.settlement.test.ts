import { expect, it, vi } from "vitest";
import { withV2SettlementFixture } from "./Runtime.settlement.fixture.ts";
import { deferred } from "./Test.fixtures.ts";

it("polls a completed turn's retained reservation until native drain, without replay or duplicate completion", async () => {
  await withV2SettlementFixture(async (f) => {
    await f.send("first");
    expect(f.owner.row?.state).toBe("terminal");
    expect(f.owner.terminalDelivered).toBe(true);
    expect(f.owner.activation?.token).toBeDefined();
    expect(f.owner.lease.hub.isDirty(f.owner.native.id)).toBe(false);
    f.setActive(false);
    await vi.waitFor(() => expect(f.owner.activation?.token).toBeUndefined(), { timeout: 2500 });
    expect(f.events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    expect(f.http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
    await f.send("second");
    expect(f.http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(2);
  });
});

it("a queued explicit send waits for the single owned drain, without overlapping polling or duplicate completion", async () => {
  await withV2SettlementFixture(async (f) => {
    await f.send("first");
    const entered = deferred<void>(),
      drained = deferred<Record<string, never>>();
    const active = vi.spyOn(f.http.client.session, "active").mockImplementation(async () => {
      entered.resolve();
      return drained.promise;
    });
    active.mockClear();
    f.runtime.scheduleRepair(f.owner, false);
    await entered.promise;
    const next = f.send("second");
    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(active).toHaveBeenCalledTimes(1);
      expect(f.http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
      drained.resolve({});
      await next;
      expect(f.http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(2);
      expect(f.events.filter((event) => event.type === "turn.completed")).toHaveLength(2);
    } finally {
      drained.resolve({});
      await next.catch(() => {});
      active.mockRestore();
    }
  });
});

it("a new explicit send rechecks terminal settlement but cannot bypass a still-active owner", async () => {
  await withV2SettlementFixture(async (f) => {
    await f.send("first");
    const token = f.owner.activation?.token;
    await expect(f.send("blocked")).rejects.toThrow(
      "V2 prior physical admission remains owned (hold: native-active); no new turn.",
    );
    expect(f.owner.activation?.token).toBe(token);
    f.setActive(false);
    await f.send("second");
    expect(f.http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(2);
  });
});
