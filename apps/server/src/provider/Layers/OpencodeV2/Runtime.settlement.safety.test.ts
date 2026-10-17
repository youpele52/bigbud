import * as Effect from "effect/Effect";
import { expect, it, vi } from "vitest";
import { withV2SettlementFixture } from "./Runtime.settlement.fixture.ts";
import { settleV2RuntimeReservation } from "./Runtime.activation.ts";
import { runV2RequestContext } from "./Client.guard.ts";
import { deferred } from "./Test.fixtures.ts";

it.each([
  "native",
  "callback",
  "mutation",
  "journal",
  "binding",
  "publication",
  "physical",
] as const)(
  "terminal delivery does not release a reservation with %s still unresolved",
  async (kind) => {
    await withV2SettlementFixture(async (f) => {
      await f.send("first");
      f.setActive(kind === "native");
      const token = f.owner.activation!.token!;
      const sdk = deferred<void>();
      let physical: Promise<void> | undefined;
      let restore: (() => void) | undefined;
      if (kind === "callback")
        f.owner.coding = {
          pending: () => [],
          revoke: () => {},
          cancelActive: async () => {},
          busyCount: () => 1,
        };
      if (kind === "mutation") {
        const spy = vi.spyOn(f.runtime.mutations, "busyCount").mockReturnValue(1);
        restore = () => spy.mockRestore();
      }
      if (kind === "journal") {
        const unknown = { ...f.owner.row!, state: "dispatch-intent" as const };
        const spy = vi
          .spyOn(f.runtime.options.journal, "listBoundPage")
          .mockReturnValue(Effect.succeed([unknown]));
        restore = () => spy.mockRestore();
      }
      if (kind === "binding") {
        const original = await Effect.runPromise(
          f.runtime.options.sharedBindings!.find(f.owner.threadId),
        );
        const spy = vi
          .spyOn(f.runtime.options.sharedBindings!, "find")
          .mockReturnValue(Effect.succeed({ ...original!, storageIdentity: "foreign" }));
        restore = () => spy.mockRestore();
      }
      if (kind === "publication") f.owner.publicationUnconfirmed = true;
      if (kind === "physical") physical = f.gate.dispatch(token, () => sdk.promise);
      try {
        const settle = settleV2RuntimeReservation(f.runtime, f.owner);
        if (kind === "physical") await expect(settle).rejects.toThrow("settlement unproved");
        else
          expect(await settle).toBe(
            {
              native: "native-active",
              callback: "coding-busy",
              mutation: "mutations-busy",
              journal: "unresolved-journal",
              binding: "binding",
              publication: "publication-unconfirmed",
            }[kind],
          );
        expect(f.owner.activation?.token).toBe(token);
        expect(f.gate.busyCount()).toBe(1);
        expect(f.http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
      } finally {
        restore?.();
        delete f.owner.coding;
        delete f.owner.publicationUnconfirmed;
        sdk.resolve();
        await physical;
      }
    });
  },
);

it.each(["generation", "successor", "consent", "signal", "late-callback"] as const)(
  "a delayed drain cannot discharge changed %s authority",
  async (kind) => {
    await withV2SettlementFixture(async (f) => {
      await f.send("first");
      const activation = f.owner.activation!,
        token = activation.token;
      const reply = deferred<Record<string, never>>(),
        entered = deferred<void>();
      const active = vi.spyOn(f.http.client.session, "active").mockImplementation(async () => {
        entered.resolve();
        return reply.promise;
      });
      let revoked = false;
      const controller = new AbortController();
      const permit = {
        revision: 1,
        signal: new AbortController().signal,
        assertCurrent: () => {
          if (revoked) throw new Error("fixture consent revoked");
        },
        release: () => {},
      };
      const result = runV2RequestContext(
        { transport: "fixture", intent: "execute", permit, operationSignal: controller.signal },
        () => settleV2RuntimeReservation(f.runtime, f.owner),
      );
      const checked = kind === "late-callback" ? result : expect(result).rejects.toThrow();
      try {
        await entered.promise;
        if (kind === "generation") f.owner.dirtyGeneration++;
        if (kind === "successor") f.owner.activation = { ...activation };
        if (kind === "consent") revoked = true;
        if (kind === "signal") controller.abort(new Error("fixture operation expired"));
        if (kind === "late-callback") f.owner.publicationUnconfirmed = true;
        reply.resolve({});
        await checked;
        expect(activation.token).toBe(token);
        expect(f.gate.busyCount()).toBe(1);
      } finally {
        reply.resolve({});
        active.mockRestore();
        f.owner.activation = activation;
        delete f.owner.publicationUnconfirmed;
      }
    });
  },
);
