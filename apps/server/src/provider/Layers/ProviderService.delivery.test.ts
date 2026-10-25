import { Deferred, Effect, Stream } from "effect";
import { expect, it } from "vitest";
import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { withCanonicalPublicationFixture } from "./ProviderService.publication.fixture.ts";
import { withV2DeliveryFixture } from "./OpencodeV2/Runtime.delivery.fixture.ts";

for (const gap of [false, true]) {
  it(`${gap ? "real gap drops stale completion and reports explicit publication uncertainty" : "healthy SSE completion survives paused real canonical logging after the hub callback"}`, async () => {
    const entered = Effect.runSync(Deferred.make<void>()),
      release = Effect.runSync(Deferred.make<void>());
    let paused = false;
    await withCanonicalPublicationFixture(
      ({ service, native, liveness }) =>
        Effect.gen(function* () {
          const received: ProviderRuntimeEvent[] = [];
          yield* Stream.runForEach(service.streamEvents, (event) =>
            Effect.sync(() => received.push(event)),
          ).pipe(Effect.forkScoped);
          yield* Effect.sleep("10 millis");
          yield* Effect.promise(() =>
            withV2DeliveryFixture(
              (event) => native.emit(event),
              async ({ owner, runtime, callback, dirtyReasons, deliver }) => {
                await Effect.runPromise(
                  liveness.startTurn({
                    threadId: owner.threadId,
                    turnId: owner.row!.turnId,
                    provider: "opencodeV2",
                    sessionEpoch: owner.epoch,
                    startedAt: new Date().toISOString(),
                  }),
                );
                const dirty = owner.dirtyGeneration;
                deliver();
                await Effect.runPromise(Deferred.await(entered));
                try {
                  await callback;
                  await new Promise((resolve) => setImmediate(resolve));
                  if (gap) owner.lease.hub.markGap();
                } finally {
                  await Effect.runPromise(Deferred.succeed(release, undefined));
                }
                if (!gap) {
                  await expect
                    .poll(() => received.filter((event) => event.type === "turn.completed").length)
                    .toBe(1);
                  expect(
                    received
                      .filter((event) => event.type === "item.completed")
                      .map((event) => event.payload),
                  ).toEqual(
                    expect.arrayContaining([
                      expect.objectContaining({
                        itemType: "dynamic_tool_call",
                        detail: "healthy final tool output",
                      }),
                      expect.objectContaining({
                        itemType: "assistant_message",
                        detail: "healthy final assistant output",
                      }),
                    ]),
                  );
                  expect(dirtyReasons).toEqual([]);
                  expect(owner.dirtyGeneration).toBe(dirty);
                  await runtime.reconcile(owner);
                  await new Promise((resolve) => setTimeout(resolve, 30));
                  expect(received.filter((event) => event.type === "turn.completed")).toHaveLength(
                    1,
                  );
                } else {
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
                  expect(owner.session.status).toBe("error");
                  expect(dirtyReasons).toContain("gap");
                  const retained = JSON.stringify(owner.row);
                  await runtime.reconcile(owner);
                  expect(JSON.stringify(owner.row)).toBe(retained);
                  expect(received.filter((event) => event.type === "turn.completed")).toEqual([]);
                }
              },
            ),
          );
        }),
      {
        logger: {
          filePath: "fixture-only",
          write: (value) => {
            const event = value as ProviderRuntimeEvent;
            if (event.type !== "item.completed" || paused) return Effect.void;
            paused = true;
            return Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.asVoid,
            );
          },
          closeThread: () => Effect.void,
          close: () => Effect.void,
        },
      },
    );
  });
}
