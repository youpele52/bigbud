import type { KilocodeSettings, ModelCapabilities, ServerProviderModel } from "@bigbud/contracts";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { ChildProcess } from "effect/unstable/process";
import { Cache, Duration, Effect, Equal, Layer, Result, Stream } from "effect";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import {
  buildServerProvider,
  providerModelsFromSettings,
  type ProviderProbeResult,
} from "../../providerSnapshot";
import { spawnAndCollect } from "../../providerSnapshot";
import { makeManagedServerProvider } from "../../makeManagedServerProvider";
import { KilocodeProvider } from "../../Services/Kilocode/Provider";
import { OpencodeServerManager } from "../../Services/Opencode/ServerManager";
import { ServerSettingsService } from "../../../ws/serverSettings";
import { ProviderAdapterProcessError } from "../../Errors";
import { getSubProviderDisplayName } from "../../subProviderDisplayNames";
import { listOpencodeProviders } from "../Opencode/Provider.sdk";
import { isVersionAtLeast } from "../Opencode/Provider.version";

const PROVIDER = "kilocode" as const;
const MINIMUM_KILOCODE_VERSION = "1.0.0";
const EMPTY_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    isCustom: false,
    group: "Anthropic",
    capabilities: {
      ...EMPTY_MODEL_CAPABILITIES,
      reasoningEffortLevels: [
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
    },
  },
  {
    slug: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    isCustom: false,
    group: "Anthropic",
    capabilities: EMPTY_MODEL_CAPABILITIES,
  },
  {
    slug: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    isCustom: false,
    group: "Anthropic",
    capabilities: {
      ...EMPTY_MODEL_CAPABILITIES,
      reasoningEffortLevels: [
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
    },
  },
];

function mapKilocodeModel(
  model: {
    id: string;
    providerID: string;
    name: string;
    capabilities?: { reasoning?: boolean };
  },
  providerName: string,
): ServerProviderModel {
  const supportsReasoning = model.capabilities?.reasoning === true;
  const modelName = model.name.trim();
  return {
    slug: model.id,
    name: modelName.length > 0 ? modelName : model.id,
    isCustom: false,
    group: getSubProviderDisplayName(providerName),
    subProviderID: model.providerID,
    capabilities: {
      ...EMPTY_MODEL_CAPABILITIES,
      reasoningEffortLevels: supportsReasoning
        ? [
            { value: "high", label: "High", isDefault: true },
            { value: "medium", label: "Medium" },
            { value: "low", label: "Low" },
          ]
        : [],
    },
  };
}

/**
 * Resolve the KiloCode binary path when the default "kilo" is not on PATH.
 *
 * The curl installer places the binary at ~/.kilo/bin/kilo.
 */
function resolveKilocodeBinary(binaryPath: string): string {
  if (binaryPath !== "kilo") return binaryPath;
  const curlPath = `${homedir()}/.kilo/bin/kilo`;
  try {
    if (existsSync(curlPath)) return curlPath;
  } catch {
    // Fall through to PATH lookup
  }
  return binaryPath;
}

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

const withKiloServer = <A>(
  binaryPath: string,
  f: (client: OpencodeClient) => Promise<A>,
): Effect.Effect<A, ProviderAdapterProcessError, OpencodeServerManager> =>
  Effect.gen(function* () {
    const manager = yield* OpencodeServerManager;
    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => manager.acquire({ provider: PROVIDER, binaryPath }),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: "provider-check",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      }),
      (handle) =>
        Effect.tryPromise({
          try: () => f(handle.client),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: "provider-check",
              detail: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        }),
      (handle) => Effect.sync(() => handle.release()),
    );
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

export const checkKilocodeProviderStatus = Effect.fn("checkKilocodeProviderStatus")(function* () {
  const kilocodeSettings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((settings) => settings.providers.kilocode),
  );
  const checkedAt = new Date().toISOString();
  const builtInModels = providerModelsFromSettings(
    BUILT_IN_MODELS,
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
    const missing =
      message.toLowerCase().includes("enoent") || message.toLowerCase().includes("not found");
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
        message: missing
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
        message: `KiloCode ${MINIMUM_KILOCODE_VERSION} or newer is required. Found ${kilocodeVersion}.`,
      },
    });
  }

  const statusResult = yield* withKiloServer(
    resolveKilocodeBinary(kilocodeSettings.binaryPath),
    async (client) => {
      const providers = await listOpencodeProviders(client);
      const hasConfiguredProviders = providers.some(
        (p) => p.models && Object.keys(p.models).length > 0,
      );

      const sdkModels: ServerProviderModel[] = [];
      for (const provider of providers) {
        if (!provider.models) continue;
        for (const model of Object.values(provider.models)) {
          sdkModels.push(mapKilocodeModel(model, provider.name));
        }
      }

      const resolvedModels =
        sdkModels.length > 0
          ? [
              ...sdkModels,
              ...providerModelsFromSettings(
                [],
                PROVIDER,
                kilocodeSettings.customModels,
                EMPTY_MODEL_CAPABILITIES,
              ),
            ]
          : builtInModels;

      const probe: ProviderProbeResult = {
        installed: true,
        version: null,
        status: hasConfiguredProviders ? "ready" : "error",
        auth: {
          status: hasConfiguredProviders ? "authenticated" : "unauthenticated",
        },
        ...(!hasConfiguredProviders
          ? {
              message:
                "No providers configured in KiloCode. Run `kilo auth` to set up provider credentials.",
            }
          : {}),
      };

      return buildServerProvider({
        provider: PROVIDER,
        enabled: kilocodeSettings.enabled,
        checkedAt,
        models: resolvedModels,
        probe,
      });
    },
  ).pipe(Effect.result);

  if (Result.isFailure(statusResult)) {
    const message = statusResult.failure.message;
    const missing =
      message.toLowerCase().includes("enoent") || message.toLowerCase().includes("not found");
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
        message: missing
          ? "KiloCode binary is not installed or not on PATH."
          : `Failed to execute KiloCode health check: ${message}`,
      },
    });
  }

  return statusResult.success;
});

export const KilocodeProviderLive = Layer.effect(
  KilocodeProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const serverManager = yield* OpencodeServerManager;
    const initialSettings = yield* serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.providers.kilocode),
    );
    const snapshotCache = yield* Cache.make({
      capacity: 1,
      timeToLive: Duration.minutes(1),
      lookup: () =>
        checkKilocodeProviderStatus().pipe(
          Effect.provideService(ServerSettingsService, serverSettings),
          Effect.provideService(OpencodeServerManager, serverManager),
        ),
    });

    const checkProvider = Cache.get(snapshotCache, "kilocode").pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(OpencodeServerManager, serverManager),
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
      initialSnapshot: makeInitialKilocodeSnapshot(initialSettings),
    });
  }),
);
