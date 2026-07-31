import type { ProviderSessionStartInput, ServerSettings } from "@bigbud/contracts";
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
import type { ClaudeHarnessConfig } from "../Claude/Adapter.types.ts";
import {
  CliProxyClientError,
  inspectCliProxy,
  validateCliProxyModel,
  type CliProxyModel,
} from "./Client.ts";
import { resolveCliProxyConfig, type CliProxyConfig } from "./config.ts";

const ACTIVATION_RETRY_ATTEMPTS = 5;
const ACTIVATION_RETRY_DELAY_MS = 1_000;

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

function processError(input: ProviderSessionStartInput, detail: string, cause?: unknown) {
  return new ProviderAdapterProcessError({
    provider: "cliProxy",
    threadId: input.threadId,
    detail,
    ...(cause === undefined ? {} : { cause }),
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
    if (lastError instanceof CliProxyClientError && lastError._tag !== "HealthProbeFailed") {
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
    throw new Error(
      claudeRunnable._tag === "timeout"
        ? "The configured Claude CLI version check timed out."
        : claudeRunnable._tag === "missing"
          ? "The configured Claude CLI is not installed or not on PATH."
          : claudeRunnable.detail,
    );
  }

  try {
    await inspect(config);
    return;
  } catch (cause) {
    if (cause instanceof CliProxyClientError && cause._tag !== "HealthProbeFailed") {
      throw cause;
    }
  }

  const activation = await input.lifecycle.activate({ configPath: config.configPath });
  if (activation._tag === "unavailable") {
    throw new Error(activation.detail);
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
      Effect.mapError((cause) =>
        processError(input, `Failed to load CLIProxyAPI settings: ${cause.message}`, cause),
      ),
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
      catch: (cause) =>
        processError(
          input,
          cause instanceof Error ? cause.message : "Failed to resolve CLIProxyAPI configuration.",
          cause,
        ),
    });

    const claudeRunnable = yield* Effect.tryPromise({
      try: () =>
        lifecycle.isClaudeRunnable({ binaryPath: settings.providers.claudeAgent.binaryPath }),
      catch: (cause) => processError(input, "Failed to inspect the configured Claude CLI.", cause),
    });
    if (claudeRunnable._tag !== "available") {
      return yield* processError(
        input,
        claudeRunnable._tag === "timeout"
          ? "The configured Claude CLI version check timed out."
          : "CLIProxyAPI requires a runnable configured Claude CLI.",
      );
    }

    const initialInspection = yield* Effect.promise(() => attemptInspection(config, inspect));
    let models: ReadonlyArray<CliProxyModel>;
    if (initialInspection._tag === "success") {
      models = initialInspection.models;
    } else {
      if (
        initialInspection.cause instanceof CliProxyClientError &&
        initialInspection.cause._tag !== "HealthProbeFailed"
      ) {
        return yield* processError(input, initialInspection.cause.message, initialInspection.cause);
      }
      const activation = yield* Effect.tryPromise({
        try: () => lifecycle.activate({ configPath: config.configPath }),
        catch: (cause) => processError(input, "CLIProxyAPI activation failed.", cause),
      });
      if (activation._tag === "unavailable") {
        return yield* processError(input, activation.detail);
      }
      const sleep =
        options.sleep ??
        ((durationMs: number) =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, durationMs);
          }));
      models = yield* Effect.tryPromise({
        try: () => inspectAfterActivation(config, inspect, sleep),
        catch: (cause) =>
          processError(
            input,
            cause instanceof Error
              ? cause.message
              : "CLIProxyAPI did not become ready after activation.",
            cause,
          ),
      });
    }

    yield* Effect.try({
      try: () => validateCliProxyModel(models, requestedModel),
      catch: (cause) =>
        new ProviderAdapterValidationError({
          provider: "cliProxy",
          operation: "startSession",
          issue:
            cause instanceof Error ? cause.message : `Model '${requestedModel}' is unavailable.`,
          ...(cause === undefined ? {} : { cause }),
        }),
    });

    const electronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
    return Object.freeze({
      config,
      models,
      ...(requestedModel ? { selectedModel: requestedModel } : {}),
      harness: Object.freeze({
        binaryPath: settings.providers.claudeAgent.binaryPath,
        settingSources: [],
        boundedHookProgress: false,
        forwardSubagentText: false,
        environment: Object.freeze({
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          ...(electronRunAsNode === undefined ? {} : { ELECTRON_RUN_AS_NODE: electronRunAsNode }),
          ANTHROPIC_BASE_URL: config.baseUrl.toString().replace(/\/$/u, ""),
          ANTHROPIC_AUTH_TOKEN: config.apiKey,
        }),
      }),
    });
  });
}

export const resolveCliProxyRuntimeConfig = makeResolveCliProxyRuntimeConfig();
