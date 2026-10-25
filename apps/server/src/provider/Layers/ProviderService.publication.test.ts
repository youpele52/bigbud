import { Deferred, Effect, Fiber, Stream } from "effect";
import { expect, it } from "vitest";
import { EventId, ThreadId, TurnId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import { guardV2Publication } from "./OpencodeV2/Runtime.publication.ts";
import { withCanonicalPublicationFixture } from "./ProviderService.publication.fixture.ts";

function event(type: ProviderRuntimeEvent["type"], id: string = type): ProviderRuntimeEvent {
  return {
    provider: "opencodeV2",
    type,
    eventId: EventId.makeUnsafe(id),
    threadId: ThreadId.makeUnsafe("canonical-owned"),
    turnId: TurnId.makeUnsafe("canonical-turn"),
    createdAt: new Date().toISOString(),
    payload: type === "turn.completed" ? { state: "completed" } : { delta: "fixture" },
  } as ProviderRuntimeEvent;
}

for (const pause of ["liveness", "logging"] as const) {
  for (const type of [
    "content.delta",
    "request.opened",
    "user-input.requested",
    "turn.completed",
  ] as const) {
    it(`drops stale ${type} after canonical ${pause} await across revoke/regrant without losing a peer stream`, async () => {
      const entered = Effect.runSync(Deferred.make<void>()),
        release = Effect.runSync(Deferred.make<void>());
      const hold = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.asVoid,
      );
      await withCanonicalPublicationFixture(
        ({ service, native, peer, liveness, settings, authority }) =>
          Effect.gen(function* () {
            const received: ProviderRuntimeEvent[] = [];
            yield* Stream.runForEach(service.streamEvents, (value) =>
              Effect.sync(() => received.push(value)),
            ).pipe(Effect.forkScoped);
            yield* Effect.sleep("10 millis");
            const stale = event(type),
              permit = authority.capture();
            guardV2Publication(stale, permit.assertCurrent);
            yield* liveness.startTurn({
              threadId: stale.threadId,
              turnId: stale.turnId!,
              provider: "opencodeV2",
              sessionEpoch: 0,
              startedAt: stale.createdAt,
            });
            native.emit(stale);
            yield* Deferred.await(entered);
            yield* settings.updateSettings({
              providers: { opencodeV2: { nativeServiceTrust: null } },
            });
            yield* settings.updateSettings({
              providers: { opencodeV2: { nativeServiceTrust: "host-user-v1" } },
            });
            yield* Deferred.succeed(release, undefined);
            peer.emit({ ...event("content.delta", "peer"), provider: "codex" });
            const fresh = event("content.delta", "fresh");
            guardV2Publication(fresh, authority.capture().assertCurrent);
            native.emit(fresh);
            yield* Effect.sleep("30 millis");
            expect(received.map((value) => value.eventId)).not.toContain(stale.eventId);
            expect(received.map((value) => value.eventId)).toContain("peer");
            expect(received.map((value) => value.eventId)).toContain("fresh");
          }),
        pause === "liveness"
          ? { afterObserve: (value) => (value.provider === "opencodeV2" ? hold : Effect.void) }
          : {
              logger: {
                filePath: "fixture-only",
                write: (value) =>
                  (value as ProviderRuntimeEvent).provider === "opencodeV2" ? hold : Effect.void,
                closeThread: () => Effect.void,
                close: () => Effect.void,
              },
            },
      );
    });
  }
}

it("rejects already-enqueued canonical events at delayed delivery and keeps original cleanup authority", async () => {
  await withCanonicalPublicationFixture(({ service, native, peer, settings, authority }) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>();
      const received: ProviderRuntimeEvent[] = [];
      const consumer = yield* Stream.runForEach(service.streamEvents, (value) =>
        value.eventId === "hold"
          ? Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.asVoid,
            )
          : Effect.sync(() => received.push(value)),
      ).pipe(Effect.forkScoped);
      yield* Effect.sleep("10 millis");
      peer.emit({ ...event("content.delta", "hold"), provider: "codex" });
      yield* Deferred.await(entered);
      const stale = event("request.opened", "buffered");
      guardV2Publication(stale, authority.capture().assertCurrent);
      native.emit(stale);
      yield* Effect.sleep("20 millis");
      yield* settings.updateSettings({ providers: { opencodeV2: { nativeServiceTrust: null } } });
      yield* settings.updateSettings({
        providers: { opencodeV2: { nativeServiceTrust: "host-user-v1" } },
      });
      let originalOwner = true;
      const cleanup = event("session.exited", "cleanup");
      guardV2Publication(cleanup, () => {
        if (!originalOwner) throw new Error("wrong cleanup owner");
      });
      native.emit(cleanup);
      yield* Deferred.succeed(release, undefined);
      yield* Effect.sleep("30 millis");
      expect(received.map((value) => value.eventId)).toEqual(["cleanup"]);
      originalOwner = false;
      const lateCleanup = event("session.exited", "wrong-cleanup");
      guardV2Publication(lateCleanup, () => {
        if (!originalOwner) throw new Error("wrong cleanup owner");
      });
      native.emit(lateCleanup);
      peer.emit({ ...event("content.delta", "still-peer"), provider: "codex" });
      yield* Effect.sleep("20 millis");
      expect(received.map((value) => value.eventId)).toEqual(["cleanup", "still-peer"]);
      yield* Fiber.interrupt(consumer);
    }),
  );
});
