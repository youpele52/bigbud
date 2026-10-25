import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { withV2SettlementFixture } from "./Runtime.settlement.fixture.ts";

it.each(["active", "queued", "dispatch-intent"] as const)(
  "does not supersede %s native work",
  async (state) => {
    await withV2SettlementFixture(async ({ runtime, owner, http, send, setActive }) => {
      vi.spyOn(http.client.session.instructions.entry, "list").mockRejectedValueOnce(
        new Error("preparation failed"),
      );
      await expect(send("protected-reservation")).rejects.toMatchObject({
        _tag: "V2PreparationFailed",
      });
      if (state === "dispatch-intent")
        owner.row = await Effect.runPromise(
          runtime.options.journal.transition(
            owner.row!,
            "dispatch-intent",
            new Date().toISOString(),
          ),
        );
      const row = owner.row!;
      const inbox = vi.spyOn(http.client.session.inbox, "list");
      if (state === "active") setActive(true);
      if (state === "queued")
        inbox.mockResolvedValueOnce([
          {
            id: "offline-queued",
            sessionID: owner.native.id,
            type: "synthetic",
            delivery: "queue",
            payload: { text: "offline fixture" },
            time: { created: 1 },
          },
        ]);
      try {
        await expect(send("blocked-new-request")).rejects.toThrow();
        expect(await Effect.runPromise(runtime.options.journal.find(row))).toEqual(row);
        expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(0);
      } finally {
        setActive(false);
        inbox.mockRestore();
      }
    });
  },
);

it("recovery never waits for native output from a cancelled pre-dispatch reservation", async () => {
  await withV2SettlementFixture(async ({ runtime, owner, http, send }) => {
    vi.spyOn(http.client.session.instructions.entry, "list").mockRejectedValueOnce(
      new Error("preparation failed"),
    );
    await expect(send("cancelled-recovery")).rejects.toMatchObject({ _tag: "V2PreparationFailed" });
    owner.row = await Effect.runPromise(
      runtime.options.journal.transition(
        owner.row!,
        "terminal",
        new Date().toISOString(),
        undefined,
        "interrupted",
      ),
    );
    const messages = vi.spyOn(http.client.message, "list");
    await runtime.reconcile(owner);
    expect(owner.session.status).toBe("ready");
    expect(owner.terminalDelivered).toBe(true);
    expect(messages).not.toHaveBeenCalled();
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(0);
  });
});

it("a new request cancels only a drained never-dispatched reservation and reaches preparation", async () => {
  await withV2SettlementFixture(async ({ runtime, owner, http, send }) => {
    const list = vi.spyOn(http.client.session.instructions.entry, "list");
    list.mockRejectedValueOnce(new Error("initial preparation failed"));
    await expect(send("old-reservation")).rejects.toMatchObject({ _tag: "V2PreparationFailed" });
    const old = owner.row!;
    list.mockRejectedValueOnce(new Error("stop new preparation before prompt"));
    await expect(send("new-reservation")).rejects.toMatchObject({ _tag: "V2PreparationFailed" });
    expect(await Effect.runPromise(runtime.options.journal.find(old))).toMatchObject({
      requestMessageId: old.requestMessageId,
      fingerprint: old.fingerprint,
      nativeAdmissionId: old.nativeAdmissionId,
      state: "terminal",
      revision: 1,
      terminalOutcome: "interrupted",
      finalText: null,
    });
    expect(owner.row).toMatchObject({ requestMessageId: "new-reservation", state: "reserved" });
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(0);
  });
});

it("does not cancel a reservation that gained dispatch intent during the drain read", async () => {
  await withV2SettlementFixture(async ({ runtime, owner, http, send }) => {
    vi.spyOn(http.client.session.instructions.entry, "list").mockRejectedValueOnce(
      new Error("preparation failed"),
    );
    await expect(send("racing-reservation")).rejects.toMatchObject({ _tag: "V2PreparationFailed" });
    const old = owner.row!;
    vi.mocked(http.client.session.active).mockImplementationOnce(async () => {
      await Effect.runPromise(
        runtime.options.journal.transition(old, "dispatch-intent", new Date().toISOString()),
      );
      return {};
    });
    await expect(send("new-racing-request")).rejects.toThrow();
    expect(await Effect.runPromise(runtime.options.journal.find(old))).toMatchObject({
      state: "dispatch-intent",
      revision: 1,
    });
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(0);
  });
});
