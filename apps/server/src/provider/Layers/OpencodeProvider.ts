import type { ModelCapabilities, OpencodeSettings, ServerProviderModel } from "@bigbud/contracts";
import { ChildProcess } from "effect/unstable/process";
import { Cache, Duration, Effect, Equal, Layer, Result, Stream } from "effect";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import {
  buildServerProvider,
  providerModelsFromSettings,
  type ProviderProbeResult,
} from "../providerSnapshot";
import { spawnAndCollect } from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { OpencodeProvider } from "../Services/OpencodeProvider";
import { OpencodeServerManager } from "../Services/OpencodeServerManager";
import { ServerSettingsService } from "../../ws/serverSettings";
import { ProviderAdapterProcessError } from "../Errors";

const PROVIDER = "opencode" as const;
const MINIMUM_OPENCODE_VERSION = "1.14.19";
const EMPTY_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

/** Fallback models when the SDK is unreachable or hasn't been configured yet. */
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

/**
 * Map an OpenCode SDK model to a `ServerProviderModel`.
 *
 * The SDK model shape is:
 * ```ts
 * { id, name, capabilities: { reasoning, ... }, ... }
 * ```
 * @param providerName - Human-readable sub-provider name (e.g. "Anthropic", "OpenAI") used for UI grouping.
 */
function mapOpencodeModel(
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
    group: providerName,
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

function parseVersion(version: string): readonly [number, number, number] | null {
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isVersionAtLeast(version: string, minimum: string): boolean {
  const parsed = parseVersion(version);
  const parsedMinimum = parseVersion(minimum);
  if (!parsed || !parsedMinimum) return true;
  for (let index = 0; index < parsed.length; index += 1) {
    const value = parsed[index]!;
    const minimumValue = parsedMinimum[index]!;
    if (value > minimumValue) return true;
    if (value < minimumValue) return false;
  }
  return true;
}

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

/**
 * Acquire a handle from the shared OpenCode server manager, run `f`, then
 * release the handle.  Reuses a running server if one is already active.
 */
const withOpencodeServer = <A>(
  f: (client: OpencodeClient) => Promise<A>,
): Effect.Effect<A, ProviderAdapterProcessError, OpencodeServerManager> =>
  Effect.gen(function* () {
    const manager = yield* OpencodeServerManager;
    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => manager.acquire(),
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

export const checkOpencodeProviderStatus = Effect.fn("checkOpencodeProviderStatus")(function* () {
  const opencodeSettings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((settings) => settings.providers.opencode),
  );
  const checkedAt = new Date().toISOString();
  const builtInModels = providerModelsFromSettings(
    BUILT_IN_MODELS,
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

  const versionResult = yield* getOpencodeVersion(opencodeSettings.binaryPath).pipe(Effect.result);

  if (Result.isFailure(versionResult)) {
    const message =
      versionResult.failure instanceof Error
        ? versionResult.failure.message
        : String(versionResult.failure);
    const missing =
      message.toLowerCase().includes("enoent") || message.toLowerCase().includes("not found");
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
        message: missing
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
        message: `OpenCode ${MINIMUM_OPENCODE_VERSION} or newer is required. Found ${opencodeVersion}.`,
      },
    });
  }

  const statusResult = yield* withOpencodeServer(async (client) => {
    // Fetch provider config to enumerate available models.
    const providersResp = await client.config.providers();

    if (providersResp.error) {
      throw new Error(`Failed to list OpenCode providers: ${String(providersResp.error)}`);
    }

    const providers = providersResp.data?.providers ?? [];
    const hasConfiguredProviders = providers.some(
      (p) => p.models && Object.keys(p.models).length > 0,
    );

    // Collect all models from all providers, preserving sub-provider name for UI grouping
    const sdkModels: ServerProviderModel[] = [];
    for (const provider of providers) {
      if (!provider.models) continue;
      for (const model of Object.values(provider.models)) {
        sdkModels.push(mapOpencodeModel(model, provider.name));
      }
    }

    const resolvedModels =
      sdkModels.length > 0
        ? [
            ...sdkModels,
            ...providerModelsFromSettings(
              [],
              PROVIDER,
              opencodeSettings.customModels,
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
              "No providers configured in OpenCode. Run `opencode auth` to set up provider credentials.",
          }
        : {}),
    };

    return buildServerProvider({
      provider: PROVIDER,
      enabled: opencodeSettings.enabled,
      checkedAt,
      models: resolvedModels,
      probe,
    });
  }).pipe(Effect.result);

  if (Result.isFailure(statusResult)) {
    const message = statusResult.failure.message;
    const missing =
      message.toLowerCase().includes("enoent") || message.toLowerCase().includes("not found");
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
        message: missing
          ? "OpenCode binary is not installed or not on PATH."
          : `Failed to execute OpenCode health check: ${message}`,
      },
    });
  }

  return statusResult.success;
});

export const OpencodeProviderLive = Layer.effect(
  OpencodeProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const serverManager = yield* OpencodeServerManager;
    const initialSettings = yield* serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.providers.opencode),
    );
    const snapshotCache = yield* Cache.make({
      capacity: 1,
      timeToLive: Duration.minutes(1),
      lookup: () =>
        checkOpencodeProviderStatus().pipe(
          Effect.provideService(ServerSettingsService, serverSettings),
          Effect.provideService(OpencodeServerManager, serverManager),
        ),
    });

    const checkProvider = Cache.get(snapshotCache, "opencode").pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(OpencodeServerManager, serverManager),
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
      initialSnapshot: makeInitialOpencodeSnapshot(initialSettings),
    });
  }),
);
