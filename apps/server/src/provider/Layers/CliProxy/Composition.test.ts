import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option, Scope } from "effect";

import { OptionalProviderRegistrations } from "../../ProviderRegistration.ts";
import { CliProxyAdapter } from "../../Services/CliProxy/Adapter.ts";
import { CliProxyLifecycle } from "../../Services/CliProxy/Lifecycle.ts";
import { CliProxyProvider } from "../../Services/CliProxy/Provider.ts";
import { isCliProxyCompositionEnabled, makeCliProxyCompositionLive } from "./Composition.ts";

it.effect("excludes every CLIProxy service when the composition is disabled", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const services = yield* Layer.build(makeCliProxyCompositionLive({ enabled: false })).pipe(
      Scope.provide(scope),
    );

    const [adapter, lifecycle, provider, registrations] = yield* Effect.all([
      Effect.serviceOption(CliProxyAdapter),
      Effect.serviceOption(CliProxyLifecycle),
      Effect.serviceOption(CliProxyProvider),
      OptionalProviderRegistrations.asEffect(),
    ]).pipe(Effect.provide(services));

    assert.equal(Option.isNone(adapter), true);
    assert.equal(Option.isNone(lifecycle), true);
    assert.equal(Option.isNone(provider), true);
    assert.deepEqual(registrations, []);
  }),
);

it("enables CLIProxy unless the deployment flag is exactly one", () => {
  assert.equal(isCliProxyCompositionEnabled({}), true);
  assert.equal(isCliProxyCompositionEnabled({ BIGBUD_DISABLE_CLIPROXY: "0" }), true);
  assert.equal(isCliProxyCompositionEnabled({ BIGBUD_DISABLE_CLIPROXY: "1" }), false);
});
