/**
 * ProviderRegistryLive - Aggregates provider-specific snapshot services.
 *
 * Provider probes are kicked off asynchronously after construction so a
 * missing CLI binary (ENOENT) never blocks server startup.  The registry
 * starts with immediate provider snapshots and hydrates verified status via
 * the individual providers' `streamChanges` streams, publishing each delta
 * through `changesPubSub`.
 *
 * @module ProviderRegistryLive
 */
import type { ProviderKind, ServerProvider } from "@bigbud/contracts";
import { Deferred, Effect, Layer, Option, PubSub, Ref, Stream } from "effect";
import { randomUUID } from "node:crypto";

import { ClaudeProviderLive } from "./Claude/Provider";
import { CopilotProviderLive } from "./Copilot/Provider";
import { CodexProviderLive } from "./Codex/Provider";
import { CursorProviderLive } from "./Cursor/Provider";
import { DevinProviderLive } from "./Devin/Provider";
import { KilocodeProviderLive } from "./Kilocode/Provider";
import { OpencodeProviderLive } from "./Opencode/Provider";
import { PiProviderLive } from "./Pi/Provider";
import { ClaudeProvider } from "../Services/Claude/Provider";
import { CopilotProvider } from "../Services/Copilot/Provider";
import { CodexProvider } from "../Services/Codex/Provider";
import { CursorProvider } from "../Services/Cursor/Provider";
import { DevinProvider } from "../Services/Devin/Provider";
import { KilocodeProvider } from "../Services/Kilocode/Provider";
import { OpencodeProvider } from "../Services/Opencode/Provider";
import { PiProvider } from "../Services/Pi/Provider";
import { ProviderRegistry, type ProviderRegistryShape } from "../Services/ProviderRegistry";
import type { ProviderRegistration } from "../ProviderRegistration.ts";
import { haveProviderSnapshotsChanged } from "../providerSnapshot.equal";
import { isProviderRetryable, needsProviderRefresh } from "../providerRecovery";

const MANUAL_REFRESH_MAX_ATTEMPTS = 3;
const MANUAL_REFRESH_DELAYS = ["1 second", "3 seconds"] as const;

export function selectManualRefreshTargets(
  registrations: ReadonlyArray<ProviderRegistration>,
  providers: ReadonlyArray<ServerProvider>,
  provider?: ProviderKind,
): ReadonlyArray<ProviderRegistration> {
  if (provider !== undefined) {
    const snapshot = providers.find((candidate) => candidate.provider === provider);
    if (!snapshot?.enabled) return [];
    return registrations.filter((registration) => registration.provider === provider);
  }
  const failed = registrations.filter((registration) => {
    const snapshot = providers.find((candidate) => candidate.provider === registration.provider);
    return snapshot !== undefined && snapshot.enabled && needsProviderRefresh(snapshot);
  });
  if (failed.length > 0) return failed;
  return registrations.filter((registration) =>
    providers.some((snapshot) => snapshot.provider === registration.provider && snapshot.enabled),
  );
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
): boolean => haveProviderSnapshotsChanged(previousProviders, nextProviders);

/** Returns the first provider with status "ready", or None. */
const findFirstReadyProvider = (
  providers: ReadonlyArray<ServerProvider>,
): Option.Option<ServerProvider> => {
  const found = providers.find((p) => p.enabled && p.status === "ready");
  return found ? Option.some(found) : Option.none();
};

const makeProviderRegistryLayer = (
  optionalRegistrations: ReadonlyArray<ProviderRegistration> = [],
) =>
  Layer.effect(
    ProviderRegistry,
    Effect.gen(function* () {
      const codexProvider = yield* CodexProvider;
      const claudeProvider = yield* ClaudeProvider;
      const copilotProvider = yield* CopilotProvider;
      const cursorProvider = yield* CursorProvider;
      const devinProvider = yield* DevinProvider;
      const kilocodeProvider = yield* KilocodeProvider;
      const opencodeProvider = yield* OpencodeProvider;
      const piProvider = yield* PiProvider;
      const registrations: ReadonlyArray<ProviderRegistration> = [
        { provider: "codex", service: codexProvider },
        { provider: "claudeAgent", service: claudeProvider },
        ...optionalRegistrations,
        { provider: "copilot", service: copilotProvider },
        { provider: "cursor", service: cursorProvider },
        { provider: "devin", service: devinProvider },
        { provider: "kilocode", service: kilocodeProvider },
        { provider: "opencode", service: opencodeProvider },
        { provider: "pi", service: piProvider },
      ];
      const changesPubSub = yield* Effect.acquireRelease(
        PubSub.unbounded<ReadonlyArray<ServerProvider>>(),
        PubSub.shutdown,
      );

      // Every managed provider supplies an immediate snapshot, so the registry
      // can expose the complete ordered list before background probes finish.
      const initialProviders = yield* loadProviders(registrations);
      const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(initialProviders);
      const manualGenerationRef = yield* Ref.make(0);

      // Latches the first provider that becomes ready.  Subsequent ready
      // providers do not override the latched value.
      const firstReadyDeferred = yield* Deferred.make<ServerProvider>();
      const initiallyReady = findFirstReadyProvider(initialProviders);
      if (Option.isSome(initiallyReady)) {
        yield* Deferred.succeed(firstReadyDeferred, initiallyReady.value).pipe(Effect.ignore);
      }

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

      yield* Effect.forEach(registrations, (registration) =>
        Stream.runForEach(registration.service.streamChanges, () => syncProviders()).pipe(
          Effect.forkScoped,
        ),
      ).pipe(Effect.asVoid);
      // A probe can complete between provider construction and stream subscription.
      // Re-read the in-memory snapshots to capture that transition without probing.
      yield* syncProviders({ publish: true }).pipe(
        Effect.ignoreCause({ log: true }),
        Effect.forkScoped,
      );

      const refresh = Effect.fn("refresh")(function* (provider?: ProviderKind) {
        const currentProviders = yield* Ref.get(providersRef);
        let targets = selectManualRefreshTargets(registrations, currentProviders, provider);
        const generation = yield* Ref.updateAndGet(
          manualGenerationRef,
          (currentGeneration) => currentGeneration + 1,
        );
        const operationId = randomUUID();
        let operationSuperseded = false;

        yield* Effect.logInfo("provider recovery operation started", {
          trigger: "manual",
          generation,
          operationId,
          providers: targets.map((target) => target.provider),
          maxAttempts: MANUAL_REFRESH_MAX_ATTEMPTS,
        });

        for (let attempt = 1; attempt <= MANUAL_REFRESH_MAX_ATTEMPTS; attempt += 1) {
          yield* Effect.all(
            targets.map((registration) =>
              registration.service.refreshWithRecovery({
                operationId,
                attempt,
                maxAttempts: MANUAL_REFRESH_MAX_ATTEMPTS,
                trigger: "manual",
              }),
            ),
            { concurrency: "unbounded" },
          );
          const providers = yield* syncProviders();
          const superseded = targets.filter((registration) => {
            const snapshot = providers.find(
              (candidate) => candidate.provider === registration.provider,
            );
            return snapshot?.recovery?.operationId !== operationId;
          });
          if (superseded.length > 0) {
            operationSuperseded = true;
            yield* Effect.logInfo("provider recovery superseded", {
              trigger: "manual",
              generation,
              operationId,
              providers: superseded.map((target) => target.provider),
            });
          }
          targets = targets.filter((registration) => {
            const snapshot = providers.find(
              (candidate) => candidate.provider === registration.provider,
            );
            return snapshot?.recovery?.operationId === operationId && isProviderRetryable(snapshot);
          });
          if (targets.length === 0 || attempt === MANUAL_REFRESH_MAX_ATTEMPTS) {
            yield* Effect.logInfo("provider recovery operation completed", {
              trigger: "manual",
              generation,
              operationId,
              attempt,
              outcome:
                targets.length > 0 ? "exhausted" : operationSuperseded ? "superseded" : "recovered",
            });
            return providers;
          }
          const delay = MANUAL_REFRESH_DELAYS[attempt - 1]!;
          yield* Effect.logInfo("provider recovery retry scheduled", {
            trigger: "manual",
            generation,
            operationId,
            providers: targets.map((target) => target.provider),
            attempt,
            delay,
          });
          yield* Effect.sleep(delay);
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

export const ProviderRegistryLive = makeProviderRegistryLayer().pipe(
  Layer.provideMerge(CodexProviderLive),
  Layer.provideMerge(ClaudeProviderLive),
  Layer.provideMerge(CopilotProviderLive),
  Layer.provideMerge(CursorProviderLive),
  Layer.provideMerge(DevinProviderLive),
  Layer.provideMerge(KilocodeProviderLive),
  Layer.provideMerge(OpencodeProviderLive),
  Layer.provideMerge(PiProviderLive),
);

export function makeProviderRegistryLive(options?: {
  readonly optionalRegistrations?: ReadonlyArray<ProviderRegistration>;
  readonly piProviderLayer?: Layer.Layer<PiProvider>;
}) {
  return makeProviderRegistryLayer(options?.optionalRegistrations).pipe(
    Layer.provideMerge(CodexProviderLive),
    Layer.provideMerge(ClaudeProviderLive),
    Layer.provideMerge(CopilotProviderLive),
    Layer.provideMerge(CursorProviderLive),
    Layer.provideMerge(DevinProviderLive),
    Layer.provideMerge(KilocodeProviderLive),
    Layer.provideMerge(OpencodeProviderLive),
    Layer.provideMerge(options?.piProviderLayer ?? PiProviderLive),
  );
}
