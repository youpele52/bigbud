import { expect, it, vi } from "vitest";
import { withV2NativeGuardProduction } from "./Subagents.production.fixture.ts";
import { deferred } from "./Test.fixtures.ts";
import { attachV2OwnedFamily } from "./Runtime.family.ts";

it("reattachment starts unknown even when the restored native generation was stopped and settled", async () => {
  await withV2NativeGuardProduction(
    async ({ runtime, owner, send }) => {
      await send("reconnect-physical-proof");
      await owner.familyControl!.fence();
      expect(owner.familyPhysicalDrain!.confirmed()).toBe(true);
      const prior = owner.familyPhysicalDrain;
      await owner.detachSubagentGuard!();
      owner.detachSubagentGuard = undefined;
      await attachV2OwnedFamily(runtime, owner);
      expect(owner.familyPhysicalDrain).not.toBe(prior);
      await owner.familyControl!.refreshNative!();
      expect(owner.familyControl!.busyCount!()).toBe(0);
      expect(owner.familyPhysicalDrain!.confirmed()).toBe(false);
      await owner.familyControl!.confirmCancellation!();
      expect(owner.familyPhysicalDrain!.confirmed()).toBe(true);
    },
    "full-access",
    "running",
    true,
  );
});

it.each([{ settled: false }, { uncertain: true }, { generation: 99 }])(
  "rejects a native cancellation response that cannot certify physical retirement: %j",
  async (changed) => {
    await withV2NativeGuardProduction(
      async ({ owner, send, nativeFamily }) => {
        await send("invalid-drain-proof");
        const stop = nativeFamily!.ledger.stop.bind(nativeFamily!.ledger);
        const spy = vi
          .spyOn(nativeFamily!.ledger, "stop")
          .mockImplementationOnce(async (...args) => ({
            ...(await stop(...args)),
            ...changed,
          }));
        try {
          await expect(owner.familyControl!.fence()).rejects.toThrow(
            "cancel-and-drain is uncertain",
          );
          expect(owner.familyPhysicalDrain!.confirmed()).toBe(false);
        } finally {
          spy.mockRestore();
        }
        await owner.familyControl!.confirmCancellation!();
        expect(owner.familyPhysicalDrain!.confirmed()).toBe(true);
      },
      "full-access",
      "running",
      true,
    );
  },
);

it("rearm dirties physical proof before authorization awaits and never reuses the preceding cancellation promise", async () => {
  await withV2NativeGuardProduction(
    async ({ owner, send, nativeFamily }) => {
      await send("drain-generation-zero");
      await owner.familyControl!.fence();
      expect(owner.familyPhysicalDrain!.confirmed()).toBe(true);
      const generation = owner.family!.generation;
      const authorize = owner.familyControl!.authorizeInput;
      const entering = deferred<void>(),
        release = deferred<void>();
      const spy = vi
        .spyOn(owner.familyControl!, "authorizeInput")
        .mockImplementation(async (row) => {
          expect(owner.familyPhysicalDrain!.confirmed()).toBe(false);
          entering.resolve();
          await release.promise;
          return authorize(row);
        });
      const sending = send("drain-generation-one");
      await entering.promise;
      try {
        expect(owner.familyPhysicalDrain!.confirmed()).toBe(false);
      } finally {
        release.resolve();
        await sending;
        spy.mockRestore();
      }
      expect(owner.family!.generation).toBe(generation + 1);
      await owner.familyControl!.refreshNative!();
      expect(owner.familyControl!.busyCount!()).toBe(0);
      expect(owner.familyPhysicalDrain!.confirmed()).toBe(false);
      const stop = vi
        .spyOn(nativeFamily!.ledger, "stop")
        .mockRejectedValueOnce(new Error("current generation drain unconfirmed"));
      await expect(owner.familyControl!.confirmCancellation!()).rejects.toThrow(
        "native family fence failed or timed out",
      );
      expect(stop).toHaveBeenCalledOnce();
      expect(owner.familyPhysicalDrain!.confirmed()).toBe(false);
      stop.mockRestore();
      await owner.familyControl!.confirmCancellation!();
      expect(owner.familyPhysicalDrain!.confirmed()).toBe(true);
    },
    "full-access",
    "running",
    true,
  );
});

it("an old in-flight native Stop response cannot certify a rearmed input", async () => {
  await withV2NativeGuardProduction(
    async ({ owner, send, nativeFamily }) => {
      await send("inflight-drain-zero");
      const entered = deferred<void>(),
        release = deferred<void>();
      const stop = nativeFamily!.ledger.stop.bind(nativeFamily!.ledger);
      const spy = vi.spyOn(nativeFamily!.ledger, "stop").mockImplementationOnce(async (...args) => {
        const proof = await stop(...args);
        entered.resolve();
        await release.promise;
        return proof;
      });
      const old = owner.familyControl!.fence().then(
        () => undefined,
        (error: unknown) => error,
      );
      await entered.promise;
      const authorizing = deferred<void>();
      const authorize = owner.family!.authorizeAdmission.bind(owner.family);
      const admission = vi
        .spyOn(owner.family!, "authorizeAdmission")
        .mockImplementation(async (...args) => {
          await authorize(...args);
          authorizing.resolve();
        });
      const sending = send("inflight-drain-one");
      try {
        // The native plugin serializes authorize behind the held Stop RPC. Local
        // authorization has already dirtied the proof and advanced the generation.
        await authorizing.promise;
        expect(owner.family!.generation).toBe(1);
      } finally {
        release.resolve();
        expect(await old).toBeInstanceOf(Error);
        await sending;
        admission.mockRestore();
        spy.mockRestore();
      }
      expect(owner.familyPhysicalDrain!.confirmed()).toBe(false);
      await owner.familyControl!.confirmCancellation!();
      expect(owner.familyPhysicalDrain!.confirmed()).toBe(true);
    },
    "full-access",
    "running",
    true,
  );
});
