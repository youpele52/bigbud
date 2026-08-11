import type { OpencodeSettings, ServerProvider, ServerProviderModel } from "@bigbud/contracts";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Effect, Equal, Layer, Result, Stream } from "effect";

import {
  buildInstalledProviderAvailability,
  buildServerProvider,
  classifyProviderExecutionFailure,
  providerModelsFromSettings,
  type ProviderProbeResult,
} from "../../providerSnapshot";
import { spawnAndCollect } from "../../providerSnapshot";
import { makeManagedServerProvider } from "../../makeManagedServerProvider";
import {
  enrichManagedServerCatalog,
  resolveManagedServerCatalog,
} from "../../managedServerCatalog";
import {
  loadManagedServerFallbackModels,
  MANAGED_SERVER_EMPTY_MODEL_CAPABILITIES as EMPTY_MODEL_CAPABILITIES,
  managedServerBuiltInModels,
} from "../../managedServerCatalogFallback";
import {
  MANAGED_SERVER_PROVIDER_PROBE_TIMEOUT,
  withManagedServerProbe,
} from "../../managedServerProbe.ts";
import { OpencodeProvider } from "../../Services/Opencode/Provider";
import { OpencodeServerManager } from "../../Services/Opencode/ServerManager";
import { ServerSettingsService } from "../../../ws/serverSettings";
import { listOpencodeProviders } from "./Provider.sdk";
import { isVersionAtLeast } from "./Provider.version";

const PROVIDER = "opencode" as const;
const MINIMUM_OPENCODE_VERSION = "1.14.19";
const BUILT_IN_MODELS = managedServerBuiltInModels(PROVIDER);

const getOpencodeVersion = Effect.fn("getOpencodeVersion")(function* (binaryPath: string) {
  const result = yield* spawnAndCollect(
    binaryPath,
    ChildProcess.make(binaryPath, ["--version"], {
      shell: process.platform === "win32",
    }),
  );
  if (result.code !== 0) {
    return yield* Effect.fail(
      new Error(
        result.stderr.trim() || result.stdout.trim() || `OpenCode exited with code ${result.code}`,
      ),
    );
  }
  return result.stdout.trim() || result.stderr.trim();
});

function makeInitialOpencodeSnapshot(settings: OpencodeSettings) {
  const checkedAt = new Date().toISOString();
  const builtInModels = providerModelsFromSettings(
    BUILT_IN_MODELS,
    PROVIDER,
    settings.customModels,
    EMPTY_MODEL_CAPABILITIES,
  );

  if (!settings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: false,
      checkedAt,
      models: builtInModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "OpenCode is disabled in bigbud settings.",
      },
    });
  }

  return buildServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models: builtInModels,
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Checking OpenCode availability...",
    },
  });
}

export const checkOpencodeProviderStatus = Effect.fn("checkOpencodeProviderStatus")(
  function* (options?: {
    readonly availabilityOnly?: boolean;
    readonly invalidateOnRunFailure?: boolean;
    readonly fallbackModels?: ReadonlyArray<ServerProviderModel>;
    readonly fallbackSource?: string;
  }) {
    const opencodeSettings = yield* Effect.service(ServerSettingsService).pipe(
      Effect.flatMap((service) => service.getSettings),
      Effect.map((settings) => settings.providers.opencode),
    );
    const checkedAt = new Date().toISOString();
    const builtInModels = providerModelsFromSettings(
      options?.fallbackModels ?? BUILT_IN_MODELS,
      PROVIDER,
      opencodeSettings.customModels,
      EMPTY_MODEL_CAPABILITIES,
    );

    if (!opencodeSettings.enabled) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: false,
        checkedAt,
        models: builtInModels,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "OpenCode is disabled in bigbud settings.",
        },
      });
    }

    const versionResult = yield* getOpencodeVersion(opencodeSettings.binaryPath).pipe(
      Effect.result,
    );

    if (Result.isFailure(versionResult)) {
      const message =
        versionResult.failure instanceof Error
          ? versionResult.failure.message
          : String(versionResult.failure);
      const failure = classifyProviderExecutionFailure({
        message,
        binaryPath: opencodeSettings.binaryPath,
        defaultBinaryPath: "opencode",
      });
      const missing =
        failure.reason === "command-not-found" || failure.reason === "invalid-binary-path";
      return buildServerProvider({
        provider: PROVIDER,
        enabled: opencodeSettings.enabled,
        checkedAt,
        models: builtInModels,
        probe: {
          installed: !missing,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          failure,
          message:
            failure.reason === "invalid-binary-path"
              ? "The configured OpenCode binary path is invalid."
              : missing
                ? "OpenCode binary is not installed or not on PATH."
                : `Failed to execute OpenCode version check: ${message}`,
        },
      });
    }

    const opencodeVersion = versionResult.success;
    if (!isVersionAtLeast(opencodeVersion, MINIMUM_OPENCODE_VERSION)) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: opencodeSettings.enabled,
        checkedAt,
        models: builtInModels,
        probe: {
          installed: true,
          version: opencodeVersion,
          status: "error",
          auth: { status: "unknown" },
          failure: { classification: "user-action-required", reason: "unsupported-version" },
          message: `OpenCode ${MINIMUM_OPENCODE_VERSION} or newer is required. Found ${opencodeVersion}.`,
        },
      });
    }

    const statusResult = yield* withManagedServerProbe<ServerProvider>({
      provider: PROVIDER,
      binaryPath: opencodeSettings.binaryPath,
      ...(options?.invalidateOnRunFailure === undefined
        ? {}
        : { invalidateOnRunFailure: options.invalidateOnRunFailure }),
      run:
        options?.availabilityOnly === true
          ? async () =>
              buildInstalledProviderAvailability({
                provider: PROVIDER,
                version: opencodeVersion,
                checkedAt,
                models: builtInModels,
                message: "OpenCode is installed and ready.",
                modelDiscovery: {
                  status: "live",
                  source: options?.fallbackSource ?? "bundled-fallback",
                  durationMs: 0,
                },
              })
          : async (client) => {
              const providers = await listOpencodeProviders(client);
              const catalog = resolveManagedServerCatalog({
                provider: PROVIDER,
                providers,
                customModels: opencodeSettings.customModels,
                builtInModels,
                emptyCapabilities: EMPTY_MODEL_CAPABILITIES,
              });

              const probe: ProviderProbeResult = {
                installed: true,
                version: null,
                status: catalog.configured ? "ready" : "error",
                auth: {
                  status: catalog.configured ? "authenticated" : "unauthenticated",
                },
                ...(!catalog.configured
                  ? {
                      failure: {
                        classification: "user-action-required",
                        reason: "configuration-required",
                      },
                      message:
                        "No providers configured in OpenCode. Run `opencode auth` to set up provider credentials.",
                    }
                  : {}),
              };

              return buildServerProvider({
                provider: PROVIDER,
                enabled: opencodeSettings.enabled,
                checkedAt,
                models: catalog.models,
                modelDiscovery: {
                  status: "live",
                  source: "opencode-provider-catalog",
                  durationMs: 0,
                },
                probe,
              });
            },
    }).pipe(Effect.result);

    if (Result.isFailure(statusResult)) {
      const message = statusResult.failure.message;
      const failure = classifyProviderExecutionFailure({
        message,
        binaryPath: opencodeSettings.binaryPath,
        defaultBinaryPath: "opencode",
      });
      const missing =
        failure.reason === "command-not-found" || failure.reason === "invalid-binary-path";
      return buildServerProvider({
        provider: PROVIDER,
        enabled: opencodeSettings.enabled,
        checkedAt,
        models: builtInModels,
        probe: {
          installed: !missing,
          version: opencodeVersion,
          status: "error",
          auth: { status: "unknown" },
          failure,
          message:
            failure.reason === "invalid-binary-path"
              ? "The configured OpenCode binary path is invalid."
              : missing
                ? "OpenCode binary is not installed or not on PATH."
                : `Failed to execute OpenCode health check: ${message}`,
        },
      });
    }

    return statusResult.success;
  },
);

export const OpencodeProviderLive = Layer.effect(
  OpencodeProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const serverManager = yield* OpencodeServerManager;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const initialSettings = yield* serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.providers.opencode),
    );
    const fallback = yield* loadManagedServerFallbackModels(PROVIDER);
    const checkProvider = checkOpencodeProviderStatus({
      availabilityOnly: true,
      fallbackModels: fallback.models,
      fallbackSource: fallback.source,
    }).pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(OpencodeServerManager, serverManager),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
    );
    const catalogProviderCheck = checkOpencodeProviderStatus({
      invalidateOnRunFailure: false,
      fallbackModels: fallback.models,
      fallbackSource: fallback.source,
    }).pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(OpencodeServerManager, serverManager),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
    );

    return yield* makeManagedServerProvider<OpencodeSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.opencode),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.opencode),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
      checkProviderAtStartup: checkProvider,
      enrichSnapshot: ({ snapshot, publishSnapshot }) =>
        snapshot.enabled && snapshot.status === "ready"
          ? enrichManagedServerCatalog({
              provider: PROVIDER,
              baseSnapshot: snapshot,
              catalogSnapshot: catalogProviderCheck,
              publishSnapshot,
            })
          : Effect.void,
      preserveEnrichedSnapshot: true,
      initialSnapshot: makeInitialOpencodeSnapshot(initialSettings),
      probeTimeout: MANAGED_SERVER_PROVIDER_PROBE_TIMEOUT,
    });
  }),
);
