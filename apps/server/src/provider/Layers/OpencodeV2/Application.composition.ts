import { Effect, Option, PubSub, Scope, Stream } from "effect";
import * as Semaphore from "effect/Semaphore";
import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import type { OptionalProviderRegistration } from "../../ProviderRegistration.ts";
import type { OpencodeV2AdapterShape } from "../../Services/OpencodeV2/Adapter.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { OpencodeV2SharedBindings } from "../../../persistence/Services/OpencodeV2SharedBindings.ts";
import { ThreadToolsActivation } from "../../Services/OpencodeV2/ThreadToolsActivation.ts";
import { runAuthorizedV2, currentV2RequestContext } from "./Client.guard.ts";
import { v2CallerContextEntry, withV2CallerAsyncContext } from "./Client.guard.async.ts";
import { readV2HealthSnapshot } from "./Application.discovery.ts";
import { v2SharedRegistrationFile } from "./SharedService.registration.ts";
import { ProviderAdapterValidationError } from "../../Errors.ts";
import { buildServerProvider } from "../../providerSnapshot.ts";
import { makeProviderSnapshotStore } from "../../providerSnapshot.store.ts";
import { makeDormantOpencodeV2Adapter } from "./Adapter.ts";
import { ServerConfig } from "../../../startup/config.ts";
import { BackendInstance } from "../../../startup/backendInstance.ts";
import { inspectV2Admissions, startV2AdmissionMaintenance } from "./Application.maintenance.ts";
import { V2_APPLICATION_CAPABILITIES } from "./Application.capabilities.ts";
import { readV2SharedApplicationConfig } from "./Application.shared.ts";
import { V2SharedServiceError } from "./SharedService.errors.ts";
import { Schedule } from "effect";
import { resolveOpencodeV2ConnectionMode } from "@bigbud/shared/serverSettings";
import { hasOpencodeV2NativeTrust } from "@bigbud/shared/opencodeNativeTrust";
import { V2_EXECUTION_CAPABILITIES } from "./Adapter.capabilities.ts";
import { v2ApplicationConfigKey } from "./Application.configKey.ts";
import { validV2Publication } from "./Runtime.publication.ts";
import { warnV2SharedRollback } from "./Application.rollback.ts";
import { invalidatedV2Snapshot } from "./Application.snapshot.ts";
import { makeV2ApplicationInvoke } from "./Application.invoke.ts";
import { makeV2ApplicationGraph, type V2ApplicationGraph } from "./Application.graph.ts";
import { V2GenerationCoordinator } from "./Application.generation.ts";

/** Settings-driven local preview. Harness authorization never leaks into application routing. */
export const makeV2ApplicationRegistration = Effect.fn("makeV2ApplicationRegistration")(
  function* () {
    const settings = yield* ServerSettingsService;
    const journal = yield* ProviderTurnAdmissions;
    const bindingService = yield* Effect.serviceOption(OpencodeV2SharedBindings);
    const bindings = Option.getOrUndefined(bindingService);
    // Composition precedes startup phases; initialize the existing idempotent settings service
    // rather than waiting on a Deferred whose starter depends on this registration layer.
    if (settings.start) yield* settings.start;
    if (settings.ready) yield* settings.ready;
    const activation = yield* ThreadToolsActivation;
    const consent = activation.consent;
    const serverConfig = yield* Effect.serviceOption(ServerConfig);
    // Absent outside the server (tests/CLI): dead-backend recovery stays disabled (fail closed).
    const backend = Option.getOrUndefined(yield* Effect.serviceOption(BackendInstance));
    // Once per composition; no lock identity is logged.
    yield* Effect.logInfo(
      `OpenCode V2 dead-backend recovery ${backend ? "enabled" : "disabled (no backend instance)"}`,
    );
    const scope = yield* Effect.scope;
    const permit = yield* Semaphore.make(1);
    const events = yield* PubSub.bounded<ProviderRuntimeEvent>(256);
    const failure = (issue: string) =>
      new ProviderAdapterValidationError({
        provider: "opencodeV2",
        operation: "configuration",
        issue,
      });
    const configuration = settings.getSettings.pipe(
      Effect.map((value) => value.providers.opencodeV2),
      Effect.mapError(() => failure("V2 settings are unavailable.")),
    );
    let lastFailureVersion: string | undefined;
    let initialized: V2ApplicationGraph | undefined;
    const generation = new V2GenerationCoordinator();
    yield* Effect.addFinalizer(() => Effect.sync(() => generation.close()));
    let maintenanceStarted = false;
    const ensure = permit.withPermits(1)(
      Effect.gen(function* () {
        const value = yield* configuration;
        if (!value.enabled)
          return yield* failure("V2 is disabled. Enable it in Providers settings.");
        if (resolveOpencodeV2ConnectionMode(value) === "isolated")
          return yield* failure(
            "V2 retired-isolated configuration is read-only. Select the shared native service for new chats; existing isolated history cannot execute or migrate.",
          );
        if (Option.isNone(serverConfig))
          return yield* failure("V2 app-owned required thread-tools storage is unavailable.");
        const key = v2ApplicationConfigKey(value);
        if (!bindings)
          return yield* failure(
            "V2 shared binding persistence is unavailable; no native execution.",
          );
        if (resolveOpencodeV2ConnectionMode(value) === "shared" && !hasOpencodeV2NativeTrust(value))
          return yield* failure(
            "V2 native service trust consent required before activating native Locations/plugins.",
          );
        if (initialized) {
          if (initialized.key !== key)
            return yield* failure(
              "V2 shared service connection changed. Restart bigbud to apply; existing history and ownership are retained.",
            );
          yield* Effect.tryPromise({
            try: () =>
              generation.run(
                async (signal, validate) => {
                  const next = await readV2SharedApplicationConfig(
                    value,
                    serverConfig.value.cwd,
                  ).catch(async (error) => {
                    validate();
                    await initialized!.detach();
                    throw error;
                  });
                  validate();
                  if (
                    next.process.sharedService.generation !== initialized!.connection.generation ||
                    initialized!.consentRevision !== consent.currentRevision()
                  ) {
                    await initialized!.replace(next, validate);
                    validate();
                    initialized!.consentRevision = consent.currentRevision();
                  }
                  await initialized!.recover(signal, validate);
                },
                () => {
                  currentV2RequestContext()?.permit.assertCurrent();
                  const latest = settings.currentSnapshot?.()?.settings.providers.opencodeV2;
                  if (
                    !latest?.enabled ||
                    v2ApplicationConfigKey(latest) !== key ||
                    !hasOpencodeV2NativeTrust(latest)
                  )
                    throw new Error("V2 settings changed during generation recovery.");
                },
              ),
            catch: (error) =>
              failure(
                error instanceof V2SharedServiceError
                  ? error.message
                  : error instanceof Error && error.message.includes("timed out")
                    ? "V2 generation recovery deadline exceeded; retained owners remain blocked until the next refresh."
                    : "V2 native generation reconnecting; retained history was not replaced or resent.",
              ),
          });
          return initialized;
        }
        lastFailureVersion = undefined;
        const config = yield* Effect.tryPromise({
          try: () =>
            readV2SharedApplicationConfig(
              value,
              Option.isSome(serverConfig) ? serverConfig.value.cwd : process.cwd(),
            ),
          catch: (error) => {
            if (error instanceof V2SharedServiceError) lastFailureVersion = error.version;
            return failure(
              error instanceof V2SharedServiceError ||
                (error instanceof Error && error.message.startsWith("V2 "))
                ? error.message
                : "V2 shared native service could not be verified. Existing history was retained.",
            );
          },
        });
        yield* inspectV2Admissions(journal).pipe(
          Effect.mapError(() =>
            failure("V2 admission inventory is unavailable; no automatic replay."),
          ),
        );
        const graph = yield* makeV2ApplicationGraph(
          config,
          key,
          serverConfig.value,
          bindings,
          backend,
        ).pipe(
          Scope.provide(scope),
          Effect.provideService(ServerSettingsService, settings),
          Effect.provideService(ProviderTurnAdmissions, journal),
          Effect.provideService(ThreadToolsActivation, activation),
        );
        currentV2RequestContext()?.permit.assertCurrent();
        yield* Stream.runForEach(graph.adapter.streamEvents, (event) =>
          Effect.sync(() => {
            if (validV2Publication(event) && !PubSub.publishUnsafe(events, event))
              throw new Error("V2 application event publication queue overflow.");
          }),
        ).pipe(Effect.forkScoped, Scope.provide(scope));
        initialized = graph;
        yield* Effect.addFinalizer(() => Effect.sync(() => generation.close())).pipe(
          Scope.provide(scope),
        );
        if (!maintenanceStarted) {
          yield* startV2AdmissionMaintenance(journal).pipe(Scope.provide(scope));
          maintenanceStarted = true;
        }
        return initialized;
      }),
    );
    const unavailable = (enabled: boolean, message: string) =>
      buildServerProvider({
        provider: "opencodeV2",
        enabled,
        checkedAt: new Date().toISOString(),
        models: [],
        probe: {
          installed: lastFailureVersion !== undefined,
          version: lastFailureVersion ?? null,
          status: "warning",
          auth: { status: "unknown" },
          message,
        },
      });
    const disabledMessage =
      "OpenCode v2 is disabled. Enable to connect to your existing native TUI service with required canonical thread-tools setup.";
    const initialSnapshot = yield* configuration.pipe(
      Effect.match({
        onFailure: () => unavailable(false, "V2 settings are unavailable."),
        onSuccess: (config) => ({
          ...unavailable(
            config.enabled,
            config.enabled ? "Checking OpenCode v2 availability..." : disabledMessage,
          ),
          initialProbeComplete: !config.enabled,
        }),
      }),
      Effect.flatMap((snapshot) => warnV2SharedRollback(bindings, snapshot)),
    );
    const snapshots = yield* makeProviderSnapshotStore(initialSnapshot, () =>
      invalidatedV2Snapshot(settings),
    );
    const refreshBody = Effect.gen(function* () {
      const config = yield* configuration;
      if (
        initialized &&
        (!config.enabled ||
          initialized.key !== v2ApplicationConfigKey(config) ||
          (resolveOpencodeV2ConnectionMode(config) === "shared" &&
            !hasOpencodeV2NativeTrust(config)) ||
          initialized.consentRevision !== consent.currentRevision())
      ) {
        generation.invalidate();
        yield* Effect.tryPromise({
          try: initialized.detach,
          catch: () =>
            failure("V2 borrowed generation retirement remains unconfirmed; history retained."),
        });
      }
      if (
        config.enabled &&
        resolveOpencodeV2ConnectionMode(config) === "shared" &&
        !hasOpencodeV2NativeTrust(config)
      ) {
        const { permit, snapshot: health } = yield* Effect.tryPromise({
          try: () => readV2HealthSnapshot(config, consent),
          catch: () => failure("V2 consent/configuration changed during health discovery."),
        });
        try {
          const snapshot = yield* warnV2SharedRollback(bindings, health);
          yield* snapshots.publish(snapshot, permit.assertCurrent);
          return snapshot;
        } finally {
          permit.release();
        }
      }
      let snapshot = !config.enabled
        ? unavailable(false, disabledMessage)
        : yield* ensure.pipe(
            Effect.flatMap((entry) => entry.provider.refresh),
            Effect.catch((error) => Effect.succeed(unavailable(true, error.issue))),
          );
      const current = yield* configuration;
      if (
        current.enabled !== config.enabled ||
        v2ApplicationConfigKey(current) !== v2ApplicationConfigKey(config)
      )
        snapshot = unavailable(
          current.enabled,
          "V2 settings changed during discovery. Refresh provider status; restart bigbud after native connection changes.",
        );
      const enterCaller = yield* v2CallerContextEntry;
      const assertCurrent = enterCaller(() => currentV2RequestContext()?.permit.assertCurrent);
      snapshot = yield* warnV2SharedRollback(bindings, snapshot);
      yield* snapshots.publish(snapshot, assertCurrent);
      return snapshot;
    }).pipe(Effect.catch(() => Effect.succeed(unavailable(false, "V2 settings are unavailable."))));
    const refresh = Effect.suspend(() => {
      const config = settings.currentSnapshot?.()?.settings.providers.opencodeV2;
      if (
        !config?.enabled ||
        !hasOpencodeV2NativeTrust(config) ||
        resolveOpencodeV2ConnectionMode(config) === "isolated"
      )
        return refreshBody;
      return Effect.tryPromise({
        try: (signal) =>
          runAuthorizedV2(consent, config.serviceFile?.trim() || v2SharedRegistrationFile(), () =>
            Effect.runPromise(withV2CallerAsyncContext(refreshBody), { signal }),
          ),
        catch: () =>
          failure("V2 consent/configuration changed during discovery; late publication rejected."),
      }).pipe(Effect.catch((error) => Effect.succeed(unavailable(true, error.issue))));
    });
    const invoke = makeV2ApplicationInvoke(settings, consent, ensure);
    const dormant = makeDormantOpencodeV2Adapter();
    const adapter: OpencodeV2AdapterShape = {
      ...dormant,
      capabilities: V2_EXECUTION_CAPABILITIES,
      runBackgroundReview: (input) => invoke((active) => active.runBackgroundReview!(input)),
      startSession: (input) => invoke((active) => active.startSession(input)),
      sendTurn: (input) => invoke((active) => active.sendTurn(input)),
      // Cleanup remains callable after disable or path edits. It must target the original owner.
      interruptTurn: (thread, turn) =>
        (initialized?.adapter ?? dormant).interruptTurn(thread, turn),
      stopSession: (thread) => (initialized?.adapter ?? dormant).stopSession(thread),
      stopAll: () => initialized?.adapter.stopAll() ?? Effect.void,
      listSessions: () => initialized?.adapter.listSessions() ?? dormant.listSessions(),
      hasSession: (thread) => initialized?.adapter.hasSession(thread) ?? dormant.hasSession(thread),
      readThread: (thread) => (initialized?.adapter ?? dormant).readThread(thread),
      inspectActiveTurn: (thread, turn) =>
        invoke((active) => active.inspectActiveTurn!(thread, turn)),
      respondToRequest: (thread, id, decision) =>
        invoke((active) => active.respondToRequest(thread, id, decision)),
      respondToUserInput: (thread, id, answers) =>
        invoke((active) => active.respondToUserInput(thread, id, answers)),
      streamEvents: Stream.fromPubSub(events).pipe(Stream.filter(validV2Publication)),
    };
    yield* settings.streamChanges.pipe(
      Stream.map((value) => JSON.stringify(value.providers.opencodeV2)),
      Stream.changes,
      Stream.runForEach(() => refresh),
      Effect.forkScoped,
    );
    if (initialSnapshot.enabled) yield* refresh.pipe(Effect.forkScoped);
    yield* Effect.repeat(
      configuration.pipe(
        Effect.flatMap((value) =>
          value.enabled && resolveOpencodeV2ConnectionMode(value) === "shared"
            ? refresh
            : Effect.void,
        ),
      ),
      Schedule.fixed("15 seconds"),
    ).pipe(Effect.forkScoped);
    return {
      provider: "opencodeV2",
      adapterService: adapter,
      providerService: {
        getSnapshot: snapshots.getSnapshot,
        refresh,
        refreshWithRecovery: () => refresh,
        streamChanges: snapshots.streamChanges,
      },
      capabilities: {
        ...V2_APPLICATION_CAPABILITIES,
        supportsRemoteProviderRuntime: false,
        supportsLocalRuntimeRemoteWorkspace: true,
        needsBuiltinsDisabled: true,
      },
    } satisfies OptionalProviderRegistration;
  },
);
