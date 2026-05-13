import type { CopilotSettings, ModelCapabilities, ServerProviderModel } from "@bigbud/contracts";
import { Cache, Duration, Effect, Equal, Layer, Result, Stream } from "effect";
import { CopilotClient, type ModelInfo } from "@github/copilot-sdk";

import {
  buildServerProvider,
  providerModelsFromSettings,
  type ProviderProbeResult,
} from "../../providerSnapshot";
import { makeManagedServerProvider } from "../../makeManagedServerProvider";
import { CopilotProvider } from "../../Services/Copilot/Provider";
import { ServerSettingsService } from "../../../ws/serverSettings";
import { ProviderAdapterProcessError } from "../../Errors";
import { makeNodeWrapperCliPath } from "./Adapter";

const PROVIDER = "copilot" as const;
const EMPTY_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gpt-5",
    name: "GPT-5",
    isCustom: false,
    capabilities: {
      ...EMPTY_MODEL_CAPABILITIES,
      reasoningEffortLevels: [
        { value: "xhigh", label: "Extra High" },
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
    },
  },
  {
    slug: "gpt-5-mini",
    name: "GPT-5 Mini",
    isCustom: false,
    capabilities: {
      ...EMPTY_MODEL_CAPABILITIES,
      reasoningEffortLevels: [
        { value: "xhigh", label: "Extra High" },
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
    },
  },
  {
    slug: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    isCustom: false,
    capabilities: EMPTY_MODEL_CAPABILITIES,
  },
];

function mapCopilotModelCapabilities(model: ModelInfo): ModelCapabilities {
  const supportsReasoningEffort = model.capabilities.supports?.reasoningEffort ?? false;
  const defaultReasoningEffort = model.defaultReasoningEffort;
  return {
    reasoningEffortLevels:
      supportsReasoningEffort && model.supportedReasoningEfforts
        ? model.supportedReasoningEfforts.map((value) => ({
            value,
            label:
              value === "xhigh" ? "Extra High" : value.charAt(0).toUpperCase() + value.slice(1),
            ...(value === defaultReasoningEffort ? { isDefault: true } : {}),
          }))
        : [],
    supportsFastMode: false,
    supportsThinkingToggle: false,
    contextWindowOptions: [],
    promptInjectedEffortLevels: [],
  };
}

function mapCopilotModel(model: ModelInfo): ServerProviderModel {
  return {
    slug: model.id,
    name: model.name,
    isCustom: false,
    capabilities: mapCopilotModelCapabilities(model),
  };
}

function formatCopilotAuthLabel(authType: string | undefined): string | undefined {
  switch (authType) {
    case "user":
      return "GitHub User";
    case "gh-cli":
      return "GitHub CLI";
    case "env":
      return "Environment Token";
    case "api-key":
      return "API Key";
    case "token":
      return "Token";
    case "hmac":
      return "HMAC";
    default:
      return undefined;
  }
}

/** Default binary path – when set, the SDK's bundled CLI is used. */
const DEFAULT_BINARY_PATH = "copilot";

function makeClient(binaryPath: string) {
  const useCustomBinary = binaryPath !== DEFAULT_BINARY_PATH;
  // When running in Electron, use a shell wrapper as cliPath so the copilot
  // CLI is spawned via the real `node` binary rather than the Electron binary.
  // See makeNodeWrapperCliPath() in CopilotAdapter.ts for full explanation.
  const resolvedCliPath = useCustomBinary ? binaryPath : makeNodeWrapperCliPath();
  return new CopilotClient({
    ...(resolvedCliPath !== undefined ? { cliPath: resolvedCliPath } : {}),
    logLevel: "error",
    autoStart: true,
  });
}

const withClient = <A>(
  binaryPath: string,
  f: (client: CopilotClient) => Promise<A>,
): Effect.Effect<A, ProviderAdapterProcessError> =>
  Effect.acquireUseRelease(
    Effect.sync(() => makeClient(binaryPath)),
    (client) =>
      Effect.tryPromise({
        try: () => f(client),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: "provider-check",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      }),
    (client) => Effect.tryPromise(() => client.stop()).pipe(Effect.orDie),
  );

export const checkCopilotProviderStatus = Effect.fn("checkCopilotProviderStatus")(function* () {
  const copilotSettings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((settings) => settings.providers.copilot),
  );
  const checkedAt = new Date().toISOString();
  const builtInModels = providerModelsFromSettings(
    BUILT_IN_MODELS,
    PROVIDER,
    copilotSettings.customModels,
    EMPTY_MODEL_CAPABILITIES,
  );

  if (!copilotSettings.enabled) {
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
        message: "GitHub Copilot is disabled in bigbud settings.",
      },
    });
  }

  const statusResult = yield* withClient(copilotSettings.binaryPath, async (client) => {
    await client.start();
    const [status, auth, models] = await Promise.all([
      client.getStatus(),
      client.getAuthStatus(),
      client.listModels(),
    ]);

    const resolvedModels =
      models.length > 0
        ? [
            ...models.map(mapCopilotModel),
            ...providerModelsFromSettings(
              [],
              PROVIDER,
              copilotSettings.customModels,
              EMPTY_MODEL_CAPABILITIES,
            ),
          ]
        : builtInModels;

    const probe: ProviderProbeResult = {
      installed: true,
      version: status.version,
      status: auth.isAuthenticated ? "ready" : "error",
      auth: {
        status: auth.isAuthenticated ? "authenticated" : "unauthenticated",
        ...(auth.authType ? { type: auth.authType } : {}),
        ...(formatCopilotAuthLabel(auth.authType)
          ? { label: formatCopilotAuthLabel(auth.authType) }
          : {}),
      },
      ...(auth.statusMessage ? { message: auth.statusMessage } : {}),
    };

    return buildServerProvider({
      provider: PROVIDER,
      enabled: copilotSettings.enabled,
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
      enabled: copilotSettings.enabled,
      checkedAt,
      models: builtInModels,
      probe: {
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? "GitHub Copilot CLI (`copilot`) is not installed or not on PATH."
          : `Failed to execute GitHub Copilot health check: ${message}`,
      },
    });
  }

  return statusResult.success;
});

export const CopilotProviderLive = Layer.effect(
  CopilotProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const snapshotCache = yield* Cache.make({
      capacity: 1,
      timeToLive: Duration.minutes(1),
      lookup: () =>
        checkCopilotProviderStatus().pipe(
          Effect.provideService(ServerSettingsService, serverSettings),
        ),
    });

    const checkProvider = Cache.get(snapshotCache, "copilot").pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
    );

    return yield* makeManagedServerProvider<CopilotSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.copilot),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.copilot),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
    });
  }),
);
