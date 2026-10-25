import { Effect } from "effect";
import { MessageId } from "@bigbud/contracts/core/baseSchemas";
import { expect, it, vi } from "vitest";
import { withV2ProductionThreadTools } from "./Orchestration.production.fixture.ts";
import { V2ThreadEnrollment } from "./Orchestration.enrollment.ts";
import { deferred, flushMicrotasks } from "./Test.fixtures.ts";
import { runWithAbortableDeadline } from "../../RequestDeadline.ts";

it.each([false, true])(
  "held timer renewal coalesces foreground readiness and isolates waiter cancellation (owner revoked=%s)",
  async (revoked) => {
    const intervals = vi.spyOn(globalThis, "setInterval");
    const ensures = vi.spyOn(V2ThreadEnrollment.prototype, "ensure");
    const now = Date.now.bind(Date);
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await withV2ProductionThreadTools(
        async ({ runtime, source, http, invoke, canonical, revokeConsent }) => {
          http.complete(source.native.id);
          await runtime.authorized(() => runtime.reconcile(source));
          expect(source.terminalDelivered).toBe(true);
          const tick = intervals.mock.calls.find(([, delay]) => delay === 20000)?.[0];
          if (typeof tick !== "function") throw new Error("Production enrollment timer missing");
          clock = vi.spyOn(Date, "now").mockImplementation(() => now() + 20001);
          const held = deferred<void>();
          const entered = deferred<void>();
          const rpc = http.client.rpc.call.bind(http.client.rpc);
          const calls = vi.spyOn(http.client.rpc, "call").mockImplementation(async (...args) => {
            if (args[0].method === "renew") {
              entered.resolve();
              await held.promise;
            }
            return rpc(...args);
          });
          const priorEnsures = ensures.mock.calls.length;
          const beforePrompts = http.calls.filter((call) =>
            call.pathname.endsWith("/prompt"),
          ).length;
          try {
            tick();
            await entered.promise;
            const timerEnsure = ensures.mock.results[priorEnsures];
            expect(timerEnsure?.type).toBe("return");
            const enrollment = ensures.mock.contexts[priorEnsures] as V2ThreadEnrollment;
            const survivingWaiter = enrollment.ensure().then(
              () => ({ ok: true }),
              (error) => ({ ok: false, error }),
            );
            const cancellation = new AbortController();
            const cancelledWaiter = runWithAbortableDeadline({
              operation: "One renewal subscriber",
              timeoutMs: 5000,
              signal: cancellation.signal,
              run: () => enrollment.ensure(),
            });
            const cancelledCheck = expect(cancelledWaiter).rejects.toThrow("cancelled");
            await flushMicrotasks();
            cancellation.abort();
            await cancelledCheck;
            expect(enrollment.controller.signal.aborted).toBe(false);
            const infoBefore = calls.mock.calls.filter(([input]) => input.method === "info").length;
            const requestMessageId = MessageId.makeUnsafe("timer-coalesced-turn");
            const sent = runtime
              .send({
                threadId: source.threadId,
                requestMessageId,
                input: "One ordinary turn during timer renewal",
              })
              .then(
                (value) => ({ ok: true as const, value }),
                (error) => ({ ok: false as const, error }),
              );
            await expect
              .poll(
                () =>
                  calls.mock.calls.filter(([input]) => input.method === "info").length > infoBefore,
              )
              .toBe(true);
            await expect.poll(() => ensures.mock.calls.length >= priorEnsures + 4).toBe(true);
            await flushMicrotasks();
            if (revoked) await revokeConsent();
            held.resolve();
            const result = await sent;
            const timerResult = await Promise.allSettled([timerEnsure!.value]);
            const survivor = await survivingWaiter;
            if (revoked) {
              expect(result.ok).toBe(false);
              expect(survivor.ok).toBe(false);
              expect(timerResult[0]?.status).toBe("rejected");
              expect(enrollment.controller.signal.aborted).toBe(true);
              expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(
                beforePrompts,
              );
              expect(
                await Effect.runPromise(
                  runtime.options.journal.find({
                    namespace: "foreground",
                    ownerThreadId: source.threadId,
                    requestMessageId,
                  }),
                ),
              ).toBeUndefined();
              expect(canonical.dispatched).toHaveLength(0);
              return;
            }
            expect(timerResult[0]?.status).toBe("fulfilled");
            expect(survivor.ok).toBe(true);
            expect(result).toMatchObject({ ok: true });
            expect(calls.mock.calls.filter(([input]) => input.method === "renew")).toHaveLength(1);
            expect(
              calls.mock.calls.find(([input]) => input.method === "renew")?.[0].input,
            ).toMatchObject({
              enrollmentNonce: enrollment.options.owner.enrollmentNonce,
              ownerDigest: enrollment.digest,
              leaseRevision: 2,
              owner: null,
            });
            expect(calls.mock.calls.some(([input]) => input.method === "enroll")).toBe(false);
            expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(
              beforePrompts + 1,
            );
            expect(
              await Effect.runPromise(
                runtime.options.journal.find({
                  namespace: "foreground",
                  ownerThreadId: source.threadId,
                  requestMessageId,
                }),
              ),
            ).toMatchObject({ state: "accepted" });
            const created = await invoke(
              "create_thread",
              { title: "Once after renewal", task: "One independent canonical child" },
              "coalesced-create",
            );
            expect(created).toMatchObject({ ok: true });
            expect(canonical.dispatched).toHaveLength(1);
          } finally {
            held.resolve();
            calls.mockRestore();
            clock?.mockRestore();
          }
        },
      );
    } finally {
      clock?.mockRestore();
      ensures.mockRestore();
      intervals.mockRestore();
    }
  },
);
