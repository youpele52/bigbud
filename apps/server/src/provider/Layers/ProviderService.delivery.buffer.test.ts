import { Deferred, Effect, Stream } from "effect";
import { expect, it } from "vitest";
import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { withCanonicalPublicationFixture } from "./ProviderService.publication.fixture.ts";
import { withV2DeliveryFixture } from "./OpencodeV2/Runtime.delivery.fixture.ts";

it("a real gap after canonical enqueue reports uncertainty when a blocked consumer drops output, without replaying accepted IDs", async () => {
  const terminalLogged = Effect.runSync(Deferred.make<void>());
  await withCanonicalPublicationFixture(
    ({ service, native, liveness }) =>
      Effect.gen(function* () {
        const received: ProviderRuntimeEvent[] = [];
        const entered = yield* Deferred.make<void>(),
          release = yield* Deferred.make<void>();
        yield* Stream.runForEach(service.streamEvents, (event) =>
          event.type === "turn.started"
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.asVoid,
              )
            : Effect.sync(() => received.push(event)),
        ).pipe(Effect.forkScoped);
        yield* Effect.sleep("10 millis");
        yield* Effect.promise(() =>
          withV2DeliveryFixture(
            (event) => native.emit(event),
            async ({ owner, deliver, callback, runtime, http }) => {
              await Effect.runPromise(Deferred.await(entered));
              await Effect.runPromise(
                liveness.startTurn({
                  threadId: owner.threadId,
                  turnId: owner.row!.turnId,
                  provider: "opencodeV2",
                  sessionEpoch: owner.epoch,
                  startedAt: new Date().toISOString(),
                }),
              );
              try {
                deliver();
                expect(await callback).toBeUndefined();
                await new Promise((resolve) => setImmediate(resolve));
                // Ensure real canonical observation/claim ran while consumer demand was held.
                await Effect.runPromise(Deferred.await(terminalLogged));
                await new Promise((resolve) => setImmediate(resolve));
                owner.lease.hub.markGap();
              } finally {
                await Effect.runPromise(Deferred.succeed(release, undefined));
              }
              await expect
                .poll(() =>
                  received.some(
                    (event) =>
                      event.type === "session.state.changed" &&
                      event.payload.state === "error" &&
                      /publication.*unconfirmed/i.test(event.payload.reason ?? ""),
                  ),
                )
                .toBe(true);
              expect(
                received.filter(
                  (event) => event.type === "item.completed" || event.type === "turn.completed",
                ),
              ).toEqual([]);
              expect(owner.terminalDelivered).toBe(false);
              await runtime.reconcile(owner);
              expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(
                1,
              );
            },
          ),
        );
      }),
    {
      logger: {
        filePath: "fixture-only",
        write: (event) =>
          (event as ProviderRuntimeEvent).type === "turn.completed"
            ? Deferred.succeed(terminalLogged, undefined).pipe(Effect.asVoid)
            : Effect.void,
        closeThread: () => Effect.void,
        close: () => Effect.void,
      },
    },
  );
});
