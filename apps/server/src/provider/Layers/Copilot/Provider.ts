import type { CopilotSettings, ModelCapabilities, ServerProviderModel } from "@bigbud/contracts";
import { CODEX_REASONING_EFFORT_OPTIONS } from "@bigbud/contracts";
import { withEffortProvenance } from "@bigbud/shared/model";
import { Effect, Equal, FileSystem, Layer, Path, Result, Stream } from "effect";
import { CopilotClient, type ModelInfo } from "@github/copilot-sdk";

import {
  buildServerProvider,
  providerModelsFromSettings,
  type ProviderProbeResult,
} from "../../providerSnapshot";
import { makeManagedServerProvider } from "../../makeManagedServerProvider";
import { makeProviderEffortCacheDecorator } from "../../providerEffortCache.ts";
import { CopilotProvider } from "../../Services/Copilot/Provider";
import { ServerSettingsService } from "../../../ws/serverSettings";
import { ServerConfig } from "../../../startup/config.ts";
import { ProviderAdapterProcessError } from "../../Errors";
import { makeCopilotClientOptions } from "./Adapter.types";

const PROVIDER = "copilot" as const;
const EMPTY_MODEL_CAPABILITIES: ModelCapabilities = withEffortProvenance(
  {
    reasoningEffortLevels: [],
    supportsFastMode: false,
    supportsThinkingToggle: false,
    contextWindowOptions: [],
    promptInjectedEffortLevels: [],
  },
  "unknown",
  "unknown",
);

const COPILOT_SENDABLE_REASONING_EFFORTS = new Set<string>(CODEX_REASONING_EFFORT_OPTIONS);

const SEED_COPILOT_REASONING_LEVELS = [
  { value: "xhigh", label: "Extra High" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
] as const;

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gpt-5",
    name: "GPT-5",
    isCustom: false,
    capabilities: withEffortProvenance(
      {
        ...EMPTY_MODEL_CAPABILITIES,
        reasoningEffortLevels: [...SEED_COPILOT_REASONING_LEVELS],
      },
      "seed",
      "seed",
    ),
  },
  {
    slug: "gpt-5-mini",
    name: "GPT-5 Mini",
    isCustom: false,
    capabilities: withEffortProvenance(
      {
        ...EMPTY_MODEL_CAPABILITIES,
        reasoningEffortLevels: [...SEED_COPILOT_REASONING_LEVELS],
      },
      "seed",
      "seed",
    ),
  },
  {
    slug: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    isCustom: false,
    capabilities: EMPTY_MODEL_CAPABILITIES,
  },
];

export function mapCopilotModelCapabilities(model: ModelInfo): ModelCapabilities {
  const rawSupportsReasoningEffort = (
    model as ModelInfo & {
      readonly capabilities?: { readonly supports?: { readonly reasoningEffort?: unknown } };
    }
  ).capabilities?.supports?.reasoningEffort;
  const supportsReasoningEffort = rawSupportsReasoningEffort === true;
  const supportsReasoningKnown = typeof rawSupportsReasoningEffort === "boolean";
  const defaultReasoningEffort = model.defaultReasoningEffort;
  const rawAdvertised = (model as ModelInfo & { readonly supportedReasoningEfforts?: unknown })
    .supportedReasoningEfforts;
  const advertisedPresent = Array.isArray(rawAdvertised);
  const advertised = advertisedPresent
    ? (rawAdvertised as ReadonlyArray<unknown>).flatMap((value) =>
        typeof value === "string" ? [value] : [],
      )
    : [];
  const sendable = advertised.filter((value) => COPILOT_SENDABLE_REASONING_EFFORTS.has(value));
  const defaultSendable =
    defaultReasoningEffort && COPILOT_SENDABLE_REASONING_EFFORTS.has(defaultReasoningEffort)
      ? defaultReasoningEffort
      : undefined;
  return withEffortProvenance(
    {
      reasoningEffortLevels: sendable.map((value) => ({
        value,
        label: value === "xhigh" ? "Extra High" : value.charAt(0).toUpperCase() + value.slice(1),
        ...(value === defaultSendable ? { isDefault: true } : {}),
      })),
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
    !supportsReasoningKnown
      ? "unknown"
      : !supportsReasoningEffort
        ? "verified-unsupported"
        : !advertisedPresent
          ? "unknown"
          : advertised.length === 0
            ? "verified-unsupported"
            : sendable.length > 0
              ? "verified-supported"
              : "verified-unsupported",
    "live",
  );
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

function makeClient(binaryPath: string) {
  return new CopilotClient(makeCopilotClientOptions({ binaryPath }));
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
    (client) => Effect.tryPromise(() => client.stop()).pipe(Effect.ignore),
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

export function makeCopilotInitialSnapshot(copilotSettings: CopilotSettings) {
  const models = providerModelsFromSettings(
    BUILT_IN_MODELS,
    PROVIDER,
    copilotSettings.customModels,
    EMPTY_MODEL_CAPABILITIES,
  );
  const checkedAt = new Date().toISOString();

  if (!copilotSettings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "GitHub Copilot is disabled in bigbud settings.",
      },
    });
  }

  return buildServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Checking GitHub Copilot availability...",
    },
  });
}

export const CopilotProviderLive = Layer.effect(
  CopilotProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const serverConfig = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const decorateSnapshot = makeProviderEffortCacheDecorator<CopilotSettings>({
      provider: PROVIDER,
      stateDir: serverConfig.stateDir,
      workspaceFingerprint: serverConfig.cwd,
      fileSystem,
      path,
      executionIdentity: (settings) => settings.binaryPath,
      configFingerprint: (settings) => JSON.stringify(settings),
    });
    const checkProvider = checkCopilotProviderStatus().pipe(
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
      decorateSnapshot,
      initialSnapshot: makeCopilotInitialSnapshot,
    });
  }),
);
