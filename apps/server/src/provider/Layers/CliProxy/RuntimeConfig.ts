import type { ProviderSessionStartInput, ServerSettings } from "@bigbud/contracts";
import type { CliProxyDiagnostic } from "@bigbud/contracts/server/server.providers.ts";
import { Effect } from "effect";

import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../../Errors.ts";
import {
  CliProxyLifecycle,
  type CliProxyLifecycleShape,
} from "../../Services/CliProxy/Lifecycle.ts";
import { CLAUDE_HARNESS_CAPABILITIES, type ClaudeHarnessConfig } from "../Claude/Adapter.types.ts";
import {
  CliProxyClientError,
  inspectCliProxy,
  validateCliProxyModel,
  type CliProxyModel,
} from "./Client.ts";
import { diagnosticForActivationResult, diagnosticForCommandResult } from "./Diagnostic.ts";
import { resolveCliProxyConfig, type CliProxyConfig } from "./config.ts";
import { cliProxyModelEnvironment, UNKNOWN_CLIPROXY_CAPABILITIES } from "./Capabilities.ts";

const ACTIVATION_RETRY_ATTEMPTS = 5;
const ACTIVATION_RETRY_DELAY_MS = 1_000;

export class CliProxyActivationFailure extends Error {
  constructor(readonly diagnostic: CliProxyDiagnostic) {
    super(diagnostic.code);
  }
}

export interface CliProxyRuntimeConfig {
  readonly config: CliProxyConfig;
  readonly models: ReadonlyArray<CliProxyModel>;
  readonly selectedModel?: string;
  readonly harness: ClaudeHarnessConfig;
}

export interface CliProxyRuntimeConfigOptions {
  readonly inspect?: typeof inspectCliProxy;
  readonly sleep?: (durationMs: number) => Promise<void>;
}

type InspectionResult =
  | { readonly _tag: "success"; readonly models: ReadonlyArray<CliProxyModel> }
  | { readonly _tag: "failure"; readonly cause: unknown };

function processError(input: ProviderSessionStartInput, detail: string) {
  return new ProviderAdapterProcessError({
    provider: "cliProxy",
    threadId: input.threadId,
    detail,
  });
}

function attemptInspection(
  config: CliProxyConfig,
  inspect: typeof inspectCliProxy,
): Promise<InspectionResult> {
  return inspect(config).then(
    (models) => ({ _tag: "success", models }),
    (cause: unknown) => ({ _tag: "failure", cause }),
  );
}

async function inspectAfterActivation(
  config: CliProxyConfig,
  inspect: typeof inspectCliProxy,
  sleep: (durationMs: number) => Promise<void>,
): Promise<ReadonlyArray<CliProxyModel>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < ACTIVATION_RETRY_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(ACTIVATION_RETRY_DELAY_MS);
    const result = await attemptInspection(config, inspect);
    if (result._tag === "success") return result.models;
    lastError = result.cause;
    if (!(lastError instanceof CliProxyClientError) || lastError._tag !== "HealthProbeFailed") {
      throw lastError;
    }
  }
  throw lastError;
}

export async function activateCliProxyRuntime(
  input: {
    readonly settings: ServerSettings;
    readonly lifecycle: CliProxyLifecycleShape;
  },
  options: CliProxyRuntimeConfigOptions = {},
): Promise<void> {
  const inspect = options.inspect ?? inspectCliProxy;
  const settings = input.settings;
  if (!settings.providers.cliProxy.enabled) {
    throw new Error("CLIProxyAPI is disabled in bigbud settings.");
  }

  const config = resolveCliProxyConfig(settings.providers.cliProxy.configPath || undefined);
  const claudeRunnable = await input.lifecycle.isClaudeRunnable({
    binaryPath: settings.providers.claudeAgent.binaryPath,
  });
  if (claudeRunnable._tag !== "available") {
    throw new CliProxyActivationFailure(diagnosticForCommandResult(claudeRunnable));
  }

  try {
    await inspect(config);
    return;
  } catch (cause) {
    if (!(cause instanceof CliProxyClientError) || cause._tag !== "HealthProbeFailed") {
      throw cause;
    }
  }

  const activation = await input.lifecycle.activate({ configPath: config.configPath });
  if (activation._tag !== "started") {
    throw new CliProxyActivationFailure(diagnosticForActivationResult(activation));
  }
  const sleep =
    options.sleep ??
    ((durationMs: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, durationMs);
      }));
  await inspectAfterActivation(config, inspect, sleep);
}

export function makeResolveCliProxyRuntimeConfig(options: CliProxyRuntimeConfigOptions = {}) {
  const inspect = options.inspect ?? inspectCliProxy;
  return Effect.fn("resolveCliProxyRuntimeConfig")(function* (
    input: ProviderSessionStartInput,
  ): Effect.fn.Return<
    CliProxyRuntimeConfig,
    ProviderAdapterError,
    ServerSettingsService | CliProxyLifecycle
  > {
    const settingsService = yield* ServerSettingsService;
    const lifecycle = yield* CliProxyLifecycle;
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(() => processError(input, "CLIProxyAPI settings are unavailable.")),
    );
    if (!settings.providers.cliProxy.enabled) {
      return yield* new ProviderAdapterValidationError({
        provider: "cliProxy",
        operation: "startSession",
        issue: "CLIProxyAPI is disabled in bigbud settings.",
      });
    }

    const selection = input.modelSelection;
    if (!selection || selection.provider !== "cliProxy") {
      return yield* new ProviderAdapterValidationError({
        provider: "cliProxy",
        operation: "startSession",
        issue: "CLIProxyAPI requires a cliProxy modelSelection with a live model.",
      });
    }
    const requestedModel = selection.model;

    const config = yield* Effect.try({
      try: () => resolveCliProxyConfig(settings.providers.cliProxy.configPath || undefined),
      catch: () => processError(input, "CLIProxyAPI configuration is unavailable."),
    });

    const claudeRunnable = yield* Effect.tryPromise({
      try: () =>
        lifecycle.isClaudeRunnable({ binaryPath: settings.providers.claudeAgent.binaryPath }),
      catch: () => processError(input, "Failed to inspect the configured Claude CLI."),
    });
    if (claudeRunnable._tag !== "available") {
      return yield* processError(input, "CLIProxyAPI requires a runnable configured Claude CLI.");
    }

    const initialInspection = yield* Effect.promise(() => attemptInspection(config, inspect));
    let models: ReadonlyArray<CliProxyModel>;
    if (initialInspection._tag === "success") {
      models = initialInspection.models;
    } else {
      if (
        !(initialInspection.cause instanceof CliProxyClientError) ||
        initialInspection.cause._tag !== "HealthProbeFailed"
      ) {
        return yield* processError(input, "CLIProxyAPI inspection failed.");
      }
      const activation = yield* Effect.tryPromise({
        try: () => lifecycle.activate({ configPath: config.configPath }),
        catch: () => processError(input, "CLIProxyAPI activation failed."),
      });
      if (activation._tag !== "started") {
        return yield* processError(input, "CLIProxyAPI could not be activated.");
      }
      const sleep =
        options.sleep ??
        ((durationMs: number) =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, durationMs);
          }));
      models = yield* Effect.tryPromise({
        try: () => inspectAfterActivation(config, inspect, sleep),
        catch: () => processError(input, "CLIProxyAPI did not become ready after activation."),
      });
    }

    const selectedModel = yield* Effect.try({
      try: () => validateCliProxyModel(models, requestedModel),
      catch: () =>
        new ProviderAdapterValidationError({
          provider: "cliProxy",
          operation: "startSession",
          issue: "The selected CLIProxyAPI model is unavailable.",
        }),
    });

    const electronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
    const modelCapabilities = selectedModel.capabilities ?? UNKNOWN_CLIPROXY_CAPABILITIES;
    const protectedEnvironment = Object.freeze({
      ANTHROPIC_BASE_URL: config.baseUrl.toString().replace(/\/$/u, ""),
      ANTHROPIC_AUTH_TOKEN: config.apiKey,
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_CUSTOM_HEADERS: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      CLAUDE_CODE_USE_ANTHROPIC_AWS: "0",
      CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: "0",
      CLAUDE_CODE_USE_MANTLE: "0",
      CLAUDE_CODE_USE_GATEWAY: "0",
      CLAUDE_CODE_SUBAGENT_MODEL: requestedModel,
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "0",
      CLAUDE_CODE_USE_BEDROCK: "0",
      CLAUDE_CODE_USE_VERTEX: "0",
      CLAUDE_CODE_USE_FOUNDRY: "0",
      ANTHROPIC_MODEL: requestedModel,
      ANTHROPIC_SMALL_FAST_MODEL: requestedModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: requestedModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: requestedModel,
      ANTHROPIC_DEFAULT_OPUS_MODEL: requestedModel,
      ...cliProxyModelEnvironment(requestedModel, modelCapabilities),
    });
    return Object.freeze({
      config,
      models,
      ...(requestedModel ? { selectedModel: requestedModel } : {}),
      harness: Object.freeze({
        binaryPath: settings.providers.claudeAgent.binaryPath,
        modelCapabilities,
        capabilities: CLAUDE_HARNESS_CAPABILITIES,
        settingSources: ["user", "project", "local"] as const,
        protectedSettingsEnvironment: protectedEnvironment,
        environment: Object.freeze({
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          ...(electronRunAsNode === undefined ? {} : { ELECTRON_RUN_AS_NODE: electronRunAsNode }),
          ...protectedEnvironment,
        }),
      }),
    });
  });
}

export const resolveCliProxyRuntimeConfig = makeResolveCliProxyRuntimeConfig();
