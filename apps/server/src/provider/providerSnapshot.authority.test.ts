import { Deferred, Effect, Stream } from "effect";
import { expect, it } from "vitest";
import { buildServerProvider } from "./providerSnapshot.ts";
import { makeProviderSnapshotStore } from "./providerSnapshot.store.ts";
import { makeTestSettings } from "../ws/serverSettings.testing.ts";
import { V2ConsentAuthority } from "./Layers/OpencodeV2/Application.consent.ts";

it("invalidates a consented native cache and buffered delivery even after consent is regranted", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* makeTestSettings({
          providers: { opencodeV2: { enabled: true, nativeServiceTrust: "host-user-v1" } },
        });
        const authority = new V2ConsentAuthority(settings);
        yield* Effect.addFinalizer(() => Effect.sync(() => authority.close()));
        const initial = buildServerProvider({
          provider: "opencodeV2",
          enabled: true,
          checkedAt: new Date().toISOString(),
          models: [],
          probe: {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Consent required",
          },
        });
        const store = yield* makeProviderSnapshotStore(initial);
        const held = yield* Deferred.make<void>(),
          release = yield* Deferred.make<void>();
        const received: (typeof initial)[] = [];
        yield* Stream.runForEach(store.streamChanges, (snapshot) =>
          snapshot.message === "hold"
            ? Deferred.succeed(held, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.asVoid,
              )
            : Effect.sync(() => received.push(snapshot)),
        ).pipe(Effect.forkScoped);
        yield* Effect.sleep("10 millis");
        yield* store.publish({ ...initial, message: "hold" });
        yield* Deferred.await(held);
        const native = {
          ...initial,
          status: "ready" as const,
          installed: true,
          version: "2.0.26",
          auth: { status: "authenticated" as const, label: "old native auth" },
          models: [
            {
              slug: "old-native-model",
              name: "Old native model",
              isCustom: false,
              capabilities: null,
            },
          ],
        };
        yield* store.publish(native, authority.capture().assertCurrent);
        yield* settings.updateSettings({ providers: { opencodeV2: { nativeServiceTrust: null } } });
        yield* settings.updateSettings({
          providers: { opencodeV2: { nativeServiceTrust: "host-user-v1" } },
        });
        const cached = yield* store.getSnapshot;
        yield* Deferred.succeed(release, undefined);
        yield* Effect.sleep("20 millis");
        expect(cached.models).toEqual([]);
        expect(cached.auth).toEqual({ status: "unknown" });
        expect(cached.status).not.toBe("ready");
        expect(
          received.every(
            (value) =>
              value.models.length === 0 &&
              value.auth.status === "unknown" &&
              value.status !== "ready",
          ),
        ).toBe(true);
        const fresh = {
          ...native,
          models: [
            { slug: "fresh-model", name: "Fresh model", isCustom: false, capabilities: null },
          ],
        };
        yield* store.publish(fresh, authority.capture().assertCurrent);
        expect(yield* store.getSnapshot).toBe(fresh);
      }),
    ),
  );
});
