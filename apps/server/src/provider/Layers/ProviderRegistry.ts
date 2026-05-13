/**
 * ProviderRegistryLive - Aggregates provider-specific snapshot services.
 *
 * Provider probes are kicked off asynchronously after construction so a
 * missing CLI binary (ENOENT) never blocks server startup.  The registry
 * starts with an empty list and hydrates via the individual providers'
 * `streamChanges` streams, publishing each delta through `changesPubSub`.
 *
 * @module ProviderRegistryLive
 */
import type { ProviderKind, ServerProvider } from "@bigbud/contracts";
import { Deferred, Effect, Equal, Layer, Option, PubSub, Ref, Stream } from "effect";

import { ClaudeProviderLive } from "./Claude/Provider";
import { CopilotProviderLive } from "./Copilot/Provider";
import { CodexProviderLive } from "./Codex/Provider";
import { CursorProviderLive } from "./Cursor/Provider";
import { OpencodeProviderLive } from "./Opencode/Provider";
import { PiProviderLive } from "./Pi/Provider";
import { ClaudeProvider } from "../Services/Claude/Provider";
import { CopilotProvider } from "../Services/Copilot/Provider";
import { CodexProvider } from "../Services/Codex/Provider";
import { CursorProvider } from "../Services/Cursor/Provider";
import { OpencodeProvider } from "../Services/Opencode/Provider";
import { PiProvider } from "../Services/Pi/Provider";
import { ProviderRegistry, type ProviderRegistryShape } from "../Services/ProviderRegistry";
import type { ServerProviderShape } from "../Services/ServerProvider";

interface ProviderRegistration {
  readonly provider: ProviderKind;
  readonly service: ServerProviderShape;
}

const loadProviders = (
  registrations: ReadonlyArray<ProviderRegistration>,
): Effect.Effect<ReadonlyArray<ServerProvider>> =>
  Effect.all(
    registrations.map((registration) => registration.service.getSnapshot),
    { concurrency: "unbounded" },
  );

export const haveProvidersChanged = (
  previousProviders: ReadonlyArray<ServerProvider>,
  nextProviders: ReadonlyArray<ServerProvider>,
): boolean => !Equal.equals(previousProviders, nextProviders);

/** Returns the first provider with status "ready", or None. */
const findFirstReadyProvider = (
  providers: ReadonlyArray<ServerProvider>,
): Option.Option<ServerProvider> => {
  const found = providers.find((p) => p.enabled && p.status === "ready");
  return found ? Option.some(found) : Option.none();
};

const makeProviderRegistryLayer = Layer.effect(
  ProviderRegistry,
  Effect.gen(function* () {
    const codexProvider = yield* CodexProvider;
    const claudeProvider = yield* ClaudeProvider;
    const copilotProvider = yield* CopilotProvider;
    const cursorProvider = yield* CursorProvider;
    const opencodeProvider = yield* OpencodeProvider;
    const piProvider = yield* PiProvider;
    const registrations: ReadonlyArray<ProviderRegistration> = [
      { provider: "codex", service: codexProvider },
      { provider: "claudeAgent", service: claudeProvider },
      { provider: "copilot", service: copilotProvider },
      { provider: "cursor", service: cursorProvider },
      { provider: "opencode", service: opencodeProvider },
      { provider: "pi", service: piProvider },
    ];
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ReadonlyArray<ServerProvider>>(),
      PubSub.shutdown,
    );

    // Start empty — probes are kicked off asynchronously below.
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>([]);

    // Latches the first provider that becomes ready.  Subsequent ready
    // providers do not override the latched value.
    const firstReadyDeferred = yield* Deferred.make<ServerProvider>();

    const syncProviders = Effect.fn("syncProviders")(function* (options?: {
      readonly publish?: boolean;
    }) {
      const previousProviders = yield* Ref.get(providersRef);
      const providers = yield* loadProviders(registrations);
      yield* Ref.set(providersRef, providers);

      // Latch the first ready provider (idempotent after first success).
      const maybeReady = findFirstReadyProvider(providers);
      if (Option.isSome(maybeReady)) {
        yield* Deferred.succeed(firstReadyDeferred, maybeReady.value).pipe(Effect.ignore);
      }

      if (options?.publish !== false && haveProvidersChanged(previousProviders, providers)) {
        yield* PubSub.publish(changesPubSub, providers);
      }

      return providers;
    });

    // Kick off an initial probe for each provider asynchronously — a failure
    // in any individual probe is contained inside `makeManagedServerProvider`
    // and will surface as a degraded snapshot, never as a startup failure.
    yield* syncProviders({ publish: true }).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.forkScoped,
    );

    yield* Effect.forEach(registrations, (registration) =>
      Stream.runForEach(registration.service.streamChanges, () => syncProviders()).pipe(
        Effect.forkScoped,
      ),
    ).pipe(Effect.asVoid);

    const refresh = Effect.fn("refresh")(function* (provider?: ProviderKind) {
      if (provider !== undefined) {
        const registration = registrations.find((candidate) => candidate.provider === provider);
        if (registration) {
          yield* registration.service.refresh;
        }
      } else {
        yield* Effect.all(
          registrations.map((registration) => registration.service.refresh),
          { concurrency: "unbounded" },
        );
      }
      return yield* syncProviders();
    });

    return {
      getProviders: Ref.get(providersRef).pipe(
        Effect.tapError(Effect.logError),
        Effect.orElseSucceed(() => []),
      ),
      refresh: (provider?: ProviderKind) =>
        refresh(provider).pipe(
          Effect.tapError(Effect.logError),
          Effect.orElseSucceed(() => []),
        ),
      get streamChanges() {
        return Stream.fromPubSub(changesPubSub);
      },
      awaitFirstReadyProvider: Deferred.await(firstReadyDeferred).pipe(
        Effect.timeoutOption(10_000),
      ),
    } satisfies ProviderRegistryShape;
  }),
);

export const ProviderRegistryLive = makeProviderRegistryLayer.pipe(
  Layer.provideMerge(CodexProviderLive),
  Layer.provideMerge(ClaudeProviderLive),
  Layer.provideMerge(CopilotProviderLive),
  Layer.provideMerge(CursorProviderLive),
  Layer.provideMerge(OpencodeProviderLive),
  Layer.provideMerge(PiProviderLive),
);

export function makeProviderRegistryLive(options?: {
  readonly piProviderLayer?: Layer.Layer<PiProvider>;
}) {
  return makeProviderRegistryLayer.pipe(
    Layer.provideMerge(CodexProviderLive),
    Layer.provideMerge(ClaudeProviderLive),
    Layer.provideMerge(CopilotProviderLive),
    Layer.provideMerge(CursorProviderLive),
    Layer.provideMerge(OpencodeProviderLive),
    Layer.provideMerge(options?.piProviderLayer ?? PiProviderLive),
  );
}
