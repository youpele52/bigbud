import { Effect, Option, PubSub, Scope, Stream } from "effect";
import * as Semaphore from "effect/Semaphore";
import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import type { OptionalProviderRegistration } from "../../ProviderRegistration.ts";
import type { OpencodeV2AdapterShape } from "../../Services/OpencodeV2/Adapter.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { ProviderAdapterValidationError } from "../../Errors.ts";
import { buildServerProvider } from "../../providerSnapshot.ts";
import { makeProviderSnapshotStore } from "../../providerSnapshot.store.ts";
import { readV2ApplicationConfig } from "./Application.config.ts";
import { makeIsolatedOpencodeV2Adapter } from "./Adapter.execution.ts";
import { makeDormantOpencodeV2Adapter } from "./Adapter.ts";
import { makeV2DevelopmentProvider } from "./Development.provider.ts";
import { OpencodeV2ServerManager } from "./ServerManager.ts";
import { ServerConfig } from "../../../startup/config.ts";
import { inspectV2Admissions, startV2AdmissionMaintenance } from "./Application.maintenance.ts";
import { makeV2CodingTransport } from "./Coding.transport.ts";
import { makeV2TargetPreparation } from "./Application.targets.ts";
import { startOwnedV2SshProcess } from "./ServerManager.ssh.ts";
import { startOwnedV2Process } from "./ServerManager.child.ts";
import { V2_APPLICATION_CAPABILITIES } from "./Application.capabilities.ts";
import { readV2SharedApplicationConfig } from "./Application.shared.ts";
import { borrowV2SharedService } from "./SharedService.connection.ts";
import { V2SharedServiceError } from "./SharedService.errors.ts";
import { Schedule } from "effect";
import path from "node:path";
import { resolveOpencodeV2ConnectionMode } from "@bigbud/shared/serverSettings";
import { V2_EXECUTION_CAPABILITIES } from "./Adapter.capabilities.ts";

const keyOf = (value: {
  binaryPath: string;
  profileRoot: string;
  connectionMode?: "shared" | "isolated";
  serviceFile?: string;
}) =>
  JSON.stringify([
    resolveOpencodeV2ConnectionMode(value),
    value.binaryPath,
    value.profileRoot,
    value.serviceFile ?? "",
  ]);

/** Settings-driven local preview. Harness authorization never leaks into application routing. */
export const makeV2ApplicationRegistration = Effect.fn("makeV2ApplicationRegistration")(
  function* () {
    const settings = yield* ServerSettingsService;
    const journal = yield* ProviderTurnAdmissions;
    const serverConfig = yield* Effect.serviceOption(ServerConfig);
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
    let initialized:
      | {
          key: string;
          adapter: OpencodeV2AdapterShape;
          provider: Awaited<Effect.Success<ReturnType<typeof makeV2DevelopmentProvider>>>;
        }
      | undefined;
    const ensure = permit.withPermits(1)(
      Effect.gen(function* () {
        const value = yield* configuration;
        if (!value.enabled)
          return yield* failure("V2 is disabled. Enable it in Providers settings.");
        const key = keyOf(value);
        if (initialized) {
          if (initialized.key !== key)
            return yield* failure(
              "V2 binary/profile changed. Restart bigbud to apply; existing history and ownership are retained.",
            );
          return initialized;
        }
        lastFailureVersion = undefined;
        const config = yield* Effect.tryPromise({
          try: () =>
            resolveOpencodeV2ConnectionMode(value) === "isolated"
              ? readV2ApplicationConfig(value)
              : readV2SharedApplicationConfig(
                  value,
                  Option.isSome(serverConfig) ? serverConfig.value.cwd : process.cwd(),
                ),
          catch: (error) => {
            if (error instanceof V2SharedServiceError) lastFailureVersion = error.version;
            return failure(
              error instanceof V2SharedServiceError ||
                (error instanceof Error && error.message.startsWith("V2 "))
                ? error.message
                : "V2 profile could not be initialized. Choose a new dedicated directory with an existing private parent, or an existing bigbud-owned V2 profile.",
            );
          },
        });
        yield* inspectV2Admissions(journal).pipe(
          Effect.mapError(() =>
            failure("V2 admission inventory is unavailable; no automatic replay."),
          ),
        );
        const coding = yield* Effect.tryPromise({
          try: () =>
            config.process.sharedService
              ? Promise.resolve(undefined)
              : makeV2CodingTransport(config.process.profileRoot),
          catch: (error) =>
            failure(
              error instanceof Error && error.message.includes("plugin")
                ? error.message
                : "V2 bounded coding bridge requires Unix/Python 3 and private app storage.",
            ),
        });
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => coding?.close() ?? Promise.resolve()),
        ).pipe(Scope.provide(scope));
        const manager = new OpencodeV2ServerManager({
          maxProcesses: 26,
          start: (config) =>
            config.sharedService
              ? borrowV2SharedService(config.sharedService)
              : config.runtimeTargetId === "local"
                ? startOwnedV2Process(config)
                : startOwnedV2SshProcess(config, { protectedBootstrapConformance: true }),
          maxOwners: 32,
          maxQueuedEvents: 256,
          maxEventBytes: 2000000,
          consumerTimeoutMs: 10000,
        });
        const executionOptions = {
          manager,
          journal,
          config: { ...config.process, ...(coding ? { codingEndpoint: coding.endpoint } : {}) },
          ...(coding ? { codingBridge: coding.bridge } : {}),
          allowLocalWorkspace: true,
          enableLocalTools: true,
          ...(Option.isSome(serverConfig)
            ? {
                attachmentsDir: serverConfig.value.attachmentsDir,
                attachmentAdmissionsDir: path.join(
                  serverConfig.value.stateDir,
                  "opencode-v2-attachment-admissions",
                ),
              }
            : {}),
          authorizeExecution: async () => {
            const current = await Effect.runPromise(configuration);
            if (!current.enabled || keyOf(current) !== key)
              throw new Error(
                "V2 configuration changed or is disabled; restart bigbud after binary/profile changes.",
              );
          },
        };
        const executing = yield* makeIsolatedOpencodeV2Adapter({
          ...executionOptions,
          ...(Option.isSome(serverConfig)
            ? {
                prepareSession: makeV2TargetPreparation(
                  { ...executionOptions, emit: async () => {} },
                  serverConfig.value.stateDir,
                  undefined,
                  serverConfig.value.port,
                ),
              }
            : {}),
        }).pipe(Scope.provide(scope));
        const provider = yield* makeV2DevelopmentProvider(executing.runtime, config, true).pipe(
          Scope.provide(scope),
          Effect.provideService(ServerSettingsService, settings),
        );
        yield* Stream.runForEach(executing.adapter.streamEvents, (event) =>
          PubSub.publish(events, event),
        ).pipe(Effect.forkScoped, Scope.provide(scope));
        initialized = { key, adapter: executing.adapter, provider };
        yield* startV2AdmissionMaintenance(journal).pipe(Scope.provide(scope));
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
      "OpenCode v2 is disabled. Enable to connect to your existing native TUI service. Isolated storage is optional in advanced settings.";
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
    );
    const snapshots = yield* makeProviderSnapshotStore(initialSnapshot);
    const refresh = Effect.gen(function* () {
      const config = yield* configuration;
      if (initialized && (!config.enabled || initialized.key !== keyOf(config))) {
        const owned = yield* initialized.adapter.listSessions();
        yield* Effect.forEach(
          owned,
          (session) => initialized!.adapter.stopSession(session.threadId),
          { discard: true, concurrency: "unbounded" },
        );
      }
      let snapshot = !config.enabled
        ? unavailable(false, disabledMessage)
        : yield* ensure.pipe(
            Effect.flatMap((entry) => entry.provider.refresh),
            Effect.catch((error) => Effect.succeed(unavailable(true, error.issue))),
          );
      const current = yield* configuration;
      if (current.enabled !== config.enabled || keyOf(current) !== keyOf(config))
        snapshot = unavailable(
          current.enabled,
          "V2 settings changed during discovery. Refresh provider status; restart bigbud after binary/profile changes.",
        );
      return snapshot;
    }).pipe(
      Effect.catch(() => Effect.succeed(unavailable(false, "V2 settings are unavailable."))),
      Effect.tap(snapshots.publish),
    );
    const invoke = <T, E>(run: (adapter: OpencodeV2AdapterShape) => Effect.Effect<T, E>) =>
      ensure.pipe(Effect.flatMap((entry) => run(entry.adapter)));
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
      streamEvents: Stream.fromPubSub(events),
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
      capabilities: (yield* configuration.pipe(
        Effect.map((value) => resolveOpencodeV2ConnectionMode(value) === "isolated"),
        Effect.orElseSucceed(() => false),
      ))
        ? V2_APPLICATION_CAPABILITIES
        : {
            ...V2_APPLICATION_CAPABILITIES,
            supportsRemoteProviderRuntime: false,
            supportsLocalRuntimeRemoteWorkspace: false,
            needsBuiltinsDisabled: false,
          },
    } satisfies OptionalProviderRegistration;
  },
);
