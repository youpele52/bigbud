import type { KilocodeSettings, ServerProvider, ServerProviderModel } from "@bigbud/contracts";
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
import { KilocodeProvider } from "../../Services/Kilocode/Provider";
import { OpencodeServerManager } from "../../Services/Opencode/ServerManager";
import { ServerSettingsService } from "../../../ws/serverSettings";
import { listOpencodeProviders } from "../Opencode/Provider.sdk";
import { isVersionAtLeast } from "../Opencode/Provider.version";
import { resolveKilocodeBinary } from "./Provider.binary";

const PROVIDER = "kilocode" as const;
const MINIMUM_KILOCODE_VERSION = "1.0.0";
const BUILT_IN_MODELS = managedServerBuiltInModels(PROVIDER);

const getKilocodeVersion = Effect.fn("getKilocodeVersion")(function* (binaryPath: string) {
  const result = yield* spawnAndCollect(
    binaryPath,
    ChildProcess.make(binaryPath, ["--version"], {
      shell: process.platform === "win32",
    }),
  );
  if (result.code !== 0) {
    return yield* Effect.fail(
      new Error(
        result.stderr.trim() || result.stdout.trim() || `KiloCode exited with code ${result.code}`,
      ),
    );
  }
  return result.stdout.trim() || result.stderr.trim();
});

function makeInitialKilocodeSnapshot(settings: KilocodeSettings) {
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
        message: "KiloCode is disabled in bigbud settings.",
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
      message: "Checking KiloCode availability...",
    },
  });
}

export const checkKilocodeProviderStatus = Effect.fn("checkKilocodeProviderStatus")(
  function* (options?: {
    readonly availabilityOnly?: boolean;
    readonly invalidateOnRunFailure?: boolean;
    readonly fallbackModels?: ReadonlyArray<ServerProviderModel>;
    readonly fallbackSource?: string;
  }) {
    const kilocodeSettings = yield* Effect.service(ServerSettingsService).pipe(
      Effect.flatMap((service) => service.getSettings),
      Effect.map((settings) => settings.providers.kilocode),
    );
    const checkedAt = new Date().toISOString();
    const builtInModels = providerModelsFromSettings(
      options?.fallbackModels ?? BUILT_IN_MODELS,
      PROVIDER,
      kilocodeSettings.customModels,
      EMPTY_MODEL_CAPABILITIES,
    );

    if (!kilocodeSettings.enabled) {
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
          message: "KiloCode is disabled in bigbud settings.",
        },
      });
    }

    const versionResult = yield* getKilocodeVersion(
      resolveKilocodeBinary(kilocodeSettings.binaryPath),
    ).pipe(Effect.result);

    if (Result.isFailure(versionResult)) {
      const message =
        versionResult.failure instanceof Error
          ? versionResult.failure.message
          : String(versionResult.failure);
      const failure = classifyProviderExecutionFailure({
        message,
        binaryPath: kilocodeSettings.binaryPath,
        defaultBinaryPath: "kilo",
      });
      const missing =
        failure.reason === "command-not-found" || failure.reason === "invalid-binary-path";
      return buildServerProvider({
        provider: PROVIDER,
        enabled: kilocodeSettings.enabled,
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
              ? "The configured KiloCode binary path is invalid."
              : missing
                ? "KiloCode binary is not installed or not on PATH."
                : `Failed to execute KiloCode version check: ${message}`,
        },
      });
    }

    const kilocodeVersion = versionResult.success;
    if (!isVersionAtLeast(kilocodeVersion, MINIMUM_KILOCODE_VERSION)) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: kilocodeSettings.enabled,
        checkedAt,
        models: builtInModels,
        probe: {
          installed: true,
          version: kilocodeVersion,
          status: "error",
          auth: { status: "unknown" },
          failure: { classification: "user-action-required", reason: "unsupported-version" },
          message: `KiloCode ${MINIMUM_KILOCODE_VERSION} or newer is required. Found ${kilocodeVersion}.`,
        },
      });
    }

    const statusResult = yield* withManagedServerProbe<ServerProvider>({
      provider: PROVIDER,
      binaryPath: resolveKilocodeBinary(kilocodeSettings.binaryPath),
      ...(options?.invalidateOnRunFailure === undefined
        ? {}
        : { invalidateOnRunFailure: options.invalidateOnRunFailure }),
      run:
        options?.availabilityOnly === true
          ? async () =>
              buildInstalledProviderAvailability({
                provider: PROVIDER,
                version: kilocodeVersion,
                checkedAt,
                models: builtInModels,
                message: "KiloCode is installed and ready.",
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
                customModels: kilocodeSettings.customModels,
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
                        "No providers configured in KiloCode. Run `kilo auth` to set up provider credentials.",
                    }
                  : {}),
              };

              return buildServerProvider({
                provider: PROVIDER,
                enabled: kilocodeSettings.enabled,
                checkedAt,
                models: catalog.models,
                modelDiscovery: {
                  status: "live",
                  source: "kilocode-provider-catalog",
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
        binaryPath: kilocodeSettings.binaryPath,
        defaultBinaryPath: "kilo",
      });
      const missing =
        failure.reason === "command-not-found" || failure.reason === "invalid-binary-path";
      return buildServerProvider({
        provider: PROVIDER,
        enabled: kilocodeSettings.enabled,
        checkedAt,
        models: builtInModels,
        probe: {
          installed: !missing,
          version: kilocodeVersion,
          status: "error",
          auth: { status: "unknown" },
          failure,
          message:
            failure.reason === "invalid-binary-path"
              ? "The configured KiloCode binary path is invalid."
              : missing
                ? "KiloCode binary is not installed or not on PATH."
                : `Failed to execute KiloCode health check: ${message}`,
        },
      });
    }

    return statusResult.success;
  },
);

export const KilocodeProviderLive = Layer.effect(
  KilocodeProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const serverManager = yield* OpencodeServerManager;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const initialSettings = yield* serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.providers.kilocode),
    );
    const fallback = yield* loadManagedServerFallbackModels(PROVIDER);
    const checkProvider = checkKilocodeProviderStatus({
      availabilityOnly: true,
      fallbackModels: fallback.models,
      fallbackSource: fallback.source,
    }).pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(OpencodeServerManager, serverManager),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
    );
    const catalogProviderCheck = checkKilocodeProviderStatus({
      invalidateOnRunFailure: false,
      fallbackModels: fallback.models,
      fallbackSource: fallback.source,
    }).pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(OpencodeServerManager, serverManager),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
    );

    return yield* makeManagedServerProvider<KilocodeSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.kilocode),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.kilocode),
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
      initialSnapshot: makeInitialKilocodeSnapshot(initialSettings),
      probeTimeout: MANAGED_SERVER_PROVIDER_PROBE_TIMEOUT,
    });
  }),
);
