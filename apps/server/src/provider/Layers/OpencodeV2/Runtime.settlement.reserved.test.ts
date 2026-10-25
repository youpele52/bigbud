import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { withV2SettlementFixture } from "./Runtime.settlement.fixture.ts";
import { settleV2RuntimeReservation } from "./Runtime.activation.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { V2ActivationGate } from "./PluginSetup.activation.gate.ts";
import { sharedV2FixtureOptions } from "./SharedService.binding.fixture.ts";
import { MessageId } from "@bigbud/contracts/core/baseSchemas";

it.each([false, true])(
  "settles a recovered reserved admission only after native drain (active=%s)",
  async (active) => {
    await withV2SettlementFixture(async ({ runtime, owner, gate, http, send, setActive }) => {
      vi.spyOn(http.client.session.instructions.entry, "list").mockRejectedValueOnce(
        new Error("offline preparation failure"),
      );
      await expect(send("reserved-recovery")).rejects.toMatchObject({
        _tag: "V2PreparationFailed",
      });
      expect(owner.row?.state).toBe("reserved");
      const row = owner.row!;
      const activation = owner.activation!;
      activation.token = gate.tryReserve(activation.stamp, "recovered-reserved");
      gate.nativeRunning(activation.token!);
      activation.phase = "uncertain";
      setActive(active);
      expect(await settleV2RuntimeReservation(runtime, owner)).toBe(
        active ? "native-active" : undefined,
      );
      if (active) {
        expect(activation.token).toBeDefined();
        setActive(false);
        expect(await settleV2RuntimeReservation(runtime, owner)).toBeUndefined();
      }
      expect(activation.token).toBeUndefined();
      expect(await Effect.runPromise(runtime.options.journal.find(row))).toEqual(row);
      vi.mocked(http.client.session.instructions.entry.list).mockRejectedValueOnce(
        new Error("stop exact retry before any prompt"),
      );
      await expect(send("reserved-recovery")).rejects.toMatchObject({
        _tag: "V2PreparationFailed",
      });
      expect(owner.row).toEqual(row);
      expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(0);
    });
  },
);

it("restores a reserved admission after backend loss without marking it native-running", async () => {
  await withV2SettlementFixture(async ({ runtime, owner, http, send }) => {
    vi.spyOn(http.client.session.instructions.entry, "list").mockRejectedValueOnce(
      new Error("offline preparation failure"),
    );
    await expect(send("reserved-restart")).rejects.toMatchObject({ _tag: "V2PreparationFailed" });
    const row = owner.row!;
    const directory = owner.native.location.directory;
    owner.stopped = true;
    owner.unregister();
    owner.unsubscribeDeath();
    owner.consentPermit?.release();
    runtime.sessions.delete(owner.threadId);
    await owner.lease.release();
    await runtime.close();
    const gate = new V2ActivationGate("reserved-restart", "digest", () => {});
    const stamp = gate.verify(directory, "digest", "instance");
    const nativeRunning = vi.spyOn(gate, "nativeRunning");
    const restored = new OpencodeV2Runtime({
      ...sharedV2FixtureOptions(runtime, http),
      activation: { ...runtime.options.activation!, awaitReady: async () => ({ gate, stamp }) },
    });
    try {
      await restored.start({
        threadId: owner.threadId,
        cwd: directory,
        runtimeMode: "approval-required",
        modelSelection: {
          provider: "opencodeV2",
          subProviderID: "synthetic-provider",
          model: "synthetic-model",
        },
        resumeCursor: owner.session.resumeCursor,
      });
      expect(nativeRunning).not.toHaveBeenCalled();
      expect(restored.get(owner.threadId).activation?.token).toBeUndefined();
      expect(restored.get(owner.threadId).row).toEqual(row);
      vi.mocked(http.client.session.instructions.entry.list).mockRejectedValueOnce(
        new Error("stop restored retry before prompt"),
      );
      await expect(
        restored.send({
          threadId: owner.threadId,
          requestMessageId: MessageId.makeUnsafe("reserved-restart"),
          input: "Synthetic fixture only",
        }),
      ).rejects.toMatchObject({ _tag: "V2PreparationFailed" });
      expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(0);
    } finally {
      await restored.close();
    }
  });
});

it("retains a reserved activation if dispatch intent appears during native drain", async () => {
  await withV2SettlementFixture(async ({ runtime, owner, gate, http, send }) => {
    vi.spyOn(http.client.session.instructions.entry, "list").mockRejectedValueOnce(
      new Error("offline preparation failure"),
    );
    await expect(send("reserved-late-intent")).rejects.toMatchObject({
      _tag: "V2PreparationFailed",
    });
    const activation = owner.activation!;
    activation.token = gate.tryReserve(activation.stamp, "late-intent");
    gate.nativeRunning(activation.token!);
    vi.mocked(http.client.session.active).mockImplementationOnce(async () => {
      await Effect.runPromise(
        runtime.options.journal.transition(owner.row!, "dispatch-intent", new Date().toISOString()),
      );
      return {};
    });
    expect(await settleV2RuntimeReservation(runtime, owner)).toBe("unresolved-journal");
    expect(activation.token).toBeDefined();
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(0);
  });
});

it("does not discharge a stale reserved snapshot after durable dispatch intent", async () => {
  await withV2SettlementFixture(async ({ runtime, owner, gate, http, send }) => {
    vi.spyOn(http.client.session.instructions.entry, "list").mockRejectedValueOnce(
      new Error("offline preparation failure"),
    );
    await expect(send("reserved-intent-race")).rejects.toMatchObject({
      _tag: "V2PreparationFailed",
    });
    const activation = owner.activation!;
    activation.token = gate.tryReserve(activation.stamp, "recovered-stale-reservation");
    gate.nativeRunning(activation.token!);
    await Effect.runPromise(
      runtime.options.journal.transition(owner.row!, "dispatch-intent", new Date().toISOString()),
    );
    expect(await settleV2RuntimeReservation(runtime, owner)).toBe("unresolved-journal");
    expect(activation.token).toBeDefined();
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(0);
  });
});

it("keeps a reserved activation fenced while native input is queued", async () => {
  await withV2SettlementFixture(async ({ runtime, owner, gate, http, send }) => {
    vi.spyOn(http.client.session.instructions.entry, "list").mockRejectedValueOnce(
      new Error("offline preparation failure"),
    );
    await expect(send("reserved-queued-input")).rejects.toMatchObject({
      _tag: "V2PreparationFailed",
    });
    const activation = owner.activation!;
    activation.token = gate.tryReserve(activation.stamp, "queued-input");
    gate.nativeRunning(activation.token!);
    const inbox = vi.spyOn(http.client.session.inbox, "list").mockResolvedValueOnce([
      {
        id: "synthetic-queued",
        sessionID: owner.native.id,
        type: "synthetic",
        delivery: "queue",
        payload: { text: "offline fixture" },
        time: { created: 1 },
      },
    ]);
    expect(await settleV2RuntimeReservation(runtime, owner)).toBe("native-active");
    expect(activation.token).toBeDefined();
    inbox.mockRestore();
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(0);
  });
});
