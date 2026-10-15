import { Effect, Option, Stream } from "effect";
import path from "node:path";
import { resolveOpencodeV2ConnectionMode } from "@bigbud/shared/serverSettings";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { ServerConfig } from "../../../startup/config.ts";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { readV2ApplicationConfig } from "./Application.config.ts";
import { makeIsolatedOpencodeV2Adapter } from "./Adapter.execution.ts";
import { OpencodeV2IsolatedFixtureManager } from "./ServerManager.fixture.ts";
import { startOwnedV2Process } from "./ServerManager.child.ts";
import { startOwnedV2SshProcess } from "./ServerManager.ssh.ts";
import { makeV2CodingTransport } from "./Coding.transport.ts";
import { makeV2TargetPreparation } from "./Application.targets.ts";
import { makeV2DevelopmentProvider } from "./Development.provider.ts";
import { V2ConsentAuthority } from "./Application.consent.ts";
import { v2ApplicationConfigKey } from "./Application.configKey.ts";
import { V2_APPLICATION_CAPABILITIES } from "./Application.capabilities.ts";

/** Explicit disposable private-runtime qualification only; never imported by production composition. */
export const makeV2IsolatedApplicationFixtureRegistration = Effect.fn(
  "makeV2IsolatedApplicationFixtureRegistration",
)(function* () {
  const settings = yield* ServerSettingsService;
  const journal = yield* ProviderTurnAdmissions;
  const server = yield* Effect.serviceOption(ServerConfig);
  if (settings.start) yield* settings.start;
  const value = (yield* settings.getSettings).providers.opencodeV2;
  if (!value.enabled || resolveOpencodeV2ConnectionMode(value) !== "isolated")
    throw new Error(
      "Isolated application fixture requires explicit private settings and ownership.",
    );
  const config = yield* Effect.promise(() => readV2ApplicationConfig(value));
  const processConfig = config.process;
  if (processConfig.sharedService)
    throw new Error("Isolated fixture cannot borrow a shared service.");
  const consent = settings.currentSnapshot ? new V2ConsentAuthority(settings) : undefined;
  yield* Effect.addFinalizer(() => Effect.sync(() => consent?.close()));
  const coding = yield* Effect.promise(() => makeV2CodingTransport(processConfig.profileRoot));
  yield* Effect.addFinalizer(() => Effect.promise(() => coding.close()));
  const manager = new OpencodeV2IsolatedFixtureManager({
    maxProcesses: 26,
    start: (processConfig) =>
      processConfig.runtimeTargetId === "local"
        ? startOwnedV2Process(processConfig)
        : startOwnedV2SshProcess(processConfig, { protectedBootstrapConformance: true }),
    maxOwners: 32,
    maxQueuedEvents: 256,
    maxEventBytes: 2000000,
    consumerTimeoutMs: 10000,
    ...(consent ? { consent } : {}),
  });
  const key = v2ApplicationConfigKey(value);
  const options = {
    manager,
    journal,
    ...(consent ? { consent } : {}),
    config: { ...processConfig, codingEndpoint: coding.endpoint },
    codingBridge: coding.bridge,
    allowLocalWorkspace: true,
    enableLocalTools: true,
    ...(Option.isSome(server)
      ? {
          attachmentsDir: server.value.attachmentsDir,
          attachmentAdmissionsDir: path.join(
            server.value.stateDir,
            "opencode-v2-attachment-admissions",
          ),
        }
      : {}),
    authorizeExecution: async () => {
      const current = (await Effect.runPromise(settings.getSettings)).providers.opencodeV2;
      if (!current.enabled || v2ApplicationConfigKey(current) !== key)
        throw new Error("V2 isolated fixture configuration changed or disabled.");
    },
  };
  const executing = yield* makeIsolatedOpencodeV2Adapter({
    ...options,
    ...(Option.isSome(server)
      ? {
          prepareSession: makeV2TargetPreparation(
            { ...options, emit: async () => {} },
            server.value.stateDir,
            undefined,
            server.value.port,
          ),
        }
      : {}),
  });
  const providerService = yield* makeV2DevelopmentProvider(executing.runtime, config, true);
  const stopChangedOwners = Effect.gen(function* () {
    const current = (yield* settings.getSettings).providers.opencodeV2;
    if (current.enabled && v2ApplicationConfigKey(current) === key) return;
    const owners = yield* executing.adapter.listSessions();
    yield* Effect.forEach(owners, (owner) => executing.adapter.stopSession(owner.threadId), {
      discard: true,
      concurrency: "unbounded",
    });
  });
  yield* settings.streamChanges.pipe(
    Stream.runForEach(() => stopChangedOwners),
    Effect.forkScoped,
  );
  return {
    provider: "opencodeV2" as const,
    adapterService: executing.adapter,
    providerService: {
      ...providerService,
      refresh: stopChangedOwners.pipe(Effect.andThen(providerService.refresh)),
    },
    capabilities: V2_APPLICATION_CAPABILITIES,
  };
});
