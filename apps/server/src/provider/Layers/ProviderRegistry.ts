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

import { ClaudeProviderLive } from "./ClaudeProvider";
import { CopilotProviderLive } from "./CopilotProvider";
import { CodexProviderLive } from "./CodexProvider";
import { CursorProviderLive } from "./CursorProvider";
import { OpencodeProviderLive } from "./OpencodeProvider";
import { PiProviderLive } from "./PiProvider";
import type { ClaudeProviderShape } from "../Services/ClaudeProvider";
import { ClaudeProvider } from "../Services/ClaudeProvider";
import type { CopilotProviderShape } from "../Services/CopilotProvider";
import { CopilotProvider } from "../Services/CopilotProvider";
import type { CodexProviderShape } from "../Services/CodexProvider";
import { CodexProvider } from "../Services/CodexProvider";
import type { CursorProviderShape } from "../Services/CursorProvider";
import { CursorProvider } from "../Services/CursorProvider";
import type { OpencodeProviderShape } from "../Services/OpencodeProvider";
import { OpencodeProvider } from "../Services/OpencodeProvider";
import type { PiProviderShape } from "../Services/PiProvider";
import { PiProvider } from "../Services/PiProvider";
import { ProviderRegistry, type ProviderRegistryShape } from "../Services/ProviderRegistry";

const loadProviders = (
  codexProvider: CodexProviderShape,
  claudeProvider: ClaudeProviderShape,
  copilotProvider: CopilotProviderShape,
  cursorProvider: CursorProviderShape,
  opencodeProvider: OpencodeProviderShape,
  piProvider: PiProviderShape,
): Effect.Effect<
  readonly [
    ServerProvider,
    ServerProvider,
    ServerProvider,
    ServerProvider,
    ServerProvider,
    ServerProvider,
  ]
> =>
  Effect.all(
    [
      codexProvider.getSnapshot,
      claudeProvider.getSnapshot,
      copilotProvider.getSnapshot,
      cursorProvider.getSnapshot,
      opencodeProvider.getSnapshot,
      piProvider.getSnapshot,
    ],
    {
      concurrency: "unbounded",
    },
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
      const providers = yield* loadProviders(
        codexProvider,
        claudeProvider,
        copilotProvider,
        cursorProvider,
        opencodeProvider,
        piProvider,
      );
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

    yield* Stream.runForEach(codexProvider.streamChanges, () => syncProviders()).pipe(
      Effect.forkScoped,
    );
    yield* Stream.runForEach(claudeProvider.streamChanges, () => syncProviders()).pipe(
      Effect.forkScoped,
    );
    yield* Stream.runForEach(copilotProvider.streamChanges, () => syncProviders()).pipe(
      Effect.forkScoped,
    );
    yield* Stream.runForEach(cursorProvider.streamChanges, () => syncProviders()).pipe(
      Effect.forkScoped,
    );
    yield* Stream.runForEach(opencodeProvider.streamChanges, () => syncProviders()).pipe(
      Effect.forkScoped,
    );
    yield* Stream.runForEach(piProvider.streamChanges, () => syncProviders()).pipe(
      Effect.forkScoped,
    );

    const refresh = Effect.fn("refresh")(function* (provider?: ProviderKind) {
      switch (provider) {
        case "codex":
          yield* codexProvider.refresh;
          break;
        case "claudeAgent":
          yield* claudeProvider.refresh;
          break;
        case "copilot":
          yield* copilotProvider.refresh;
          break;
        case "cursor":
          yield* cursorProvider.refresh;
          break;
        case "opencode":
          yield* opencodeProvider.refresh;
          break;
        case "pi":
          yield* piProvider.refresh;
          break;
        default:
          yield* Effect.all(
            [
              codexProvider.refresh,
              claudeProvider.refresh,
              copilotProvider.refresh,
              cursorProvider.refresh,
              opencodeProvider.refresh,
              piProvider.refresh,
            ],
            {
              concurrency: "unbounded",
            },
          );
          break;
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
