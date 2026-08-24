import type {
  ModelCapabilities,
  ServerProvider,
  ServerProviderModel,
  ServerSettingsError,
} from "@bigbud/contracts";
import { Effect, Equal, Layer, Stream } from "effect";

import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { makeManagedServerProvider } from "../../makeManagedServerProvider.ts";
import { buildServerProvider } from "../../providerSnapshot.ts";
import { CliProxyProvider } from "../../Services/CliProxy/Provider.ts";
import { CliProxyLifecycle } from "../../Services/CliProxy/Lifecycle.ts";
import { CliProxyClientError, inspectCliProxy } from "./Client.ts";
import { CliProxyConfigError, resolveCliProxyConfig } from "./config.ts";

const PROVIDER = "cliProxy" as const;
// The current CLIProxy catalog exposes model IDs and names only. Do not infer
// effort support from names or mutate persisted IDs until native metadata exists.
const CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

function toModels(
  models: ReadonlyArray<{ readonly id: string; readonly name: string }>,
): ReadonlyArray<ServerProviderModel> {
  return models.map((model) => ({
    slug: model.id,
    name: model.name,
    isCustom: false,
    capabilities: CAPABILITIES,
  }));
}

function disabledSnapshot(checkedAt: string, message: string): ServerProvider {
  return buildServerProvider({
    provider: PROVIDER,
    enabled: false,
    checkedAt,
    models: [],
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message,
    },
  });
}

function unavailableSnapshot(input: {
  readonly checkedAt: string;
  readonly message: string;
  readonly installed?: boolean;
  readonly authStatus?: "authenticated" | "unknown";
}): ServerProvider {
  return buildServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt: input.checkedAt,
    models: [],
    probe: {
      installed: input.installed ?? false,
      version: null,
      status: "warning",
      auth: { status: input.authStatus ?? "unknown", type: "local-config" },
      message: input.message,
    },
  });
}

function configErrorMessage(error: CliProxyConfigError): string {
  switch (error._tag) {
    case "ConfigNotFound":
      return "CLIProxyAPI configuration was not found.";
    case "ConfigUnreadable":
      return "CLIProxyAPI configuration could not be read.";
    case "ConfigMalformed":
    case "ConfigInvalidShape":
      return "CLIProxyAPI configuration is malformed or has an invalid shape.";
    case "UnsupportedProtocol":
      return "CLIProxyAPI configuration uses an unsupported protocol.";
    case "UnsafeAddress":
      return "CLIProxyAPI must use a local loopback address.";
    case "InvalidPort":
      return "CLIProxyAPI configuration contains an invalid port.";
    case "MissingCredential":
      return "CLIProxyAPI configuration does not contain an API key.";
  }
}

function attemptConfigResolution(configPath: string | undefined) {
  try {
    return { _tag: "success" as const, config: resolveCliProxyConfig(configPath) };
  } catch (cause) {
    return { _tag: "failure" as const, cause };
  }
}

export const checkCliProxyProvider = Effect.fn("checkCliProxyProvider")(
  function* (): Effect.fn.Return<
    ServerProvider,
    ServerSettingsError,
    ServerSettingsService | CliProxyLifecycle
  > {
    const settings = yield* ServerSettingsService;
    const lifecycle = yield* CliProxyLifecycle;
    const providerSettings = yield* settings.getSettings;
    const cliProxySettings = providerSettings.providers.cliProxy;
    const checkedAt = new Date().toISOString();
    if (!cliProxySettings.enabled || process.env.BIGBUD_DISABLE_CLIPROXY === "1") {
      return disabledSnapshot(checkedAt, "CLIProxyAPI is disabled.");
    }

    const configResult = attemptConfigResolution(cliProxySettings.configPath || undefined);
    if (configResult._tag === "failure") {
      return unavailableSnapshot({
        checkedAt,
        message:
          configResult.cause instanceof CliProxyConfigError
            ? configErrorMessage(configResult.cause)
            : "CLIProxyAPI configuration could not be resolved.",
      });
    }

    const claudeRunnable = yield* Effect.tryPromise(() =>
      lifecycle.isClaudeRunnable({ binaryPath: providerSettings.providers.claudeAgent.binaryPath }),
    ).pipe(Effect.result);
    if (claudeRunnable._tag === "Failure") {
      return unavailableSnapshot({
        checkedAt,
        installed: true,
        message: "CLIProxyAPI requires a runnable configured Claude CLI.",
      });
    }
    if (claudeRunnable._tag === "Success" && claudeRunnable.success._tag !== "available") {
      const detail =
        claudeRunnable.success._tag === "timeout"
          ? "The configured Claude CLI version check timed out."
          : claudeRunnable.success._tag === "missing"
            ? "The configured Claude CLI is not installed or not on PATH."
            : claudeRunnable.success.detail;
      return unavailableSnapshot({
        checkedAt,
        installed: true,
        message: `CLIProxyAPI requires a runnable configured Claude CLI. ${detail}`,
      });
    }

    const result = yield* Effect.tryPromise(() => inspectCliProxy(configResult.config)).pipe(
      Effect.result,
    );
    if (result._tag === "Failure") {
      const failure: unknown = result.failure;
      const clientError = failure instanceof CliProxyClientError ? failure : undefined;
      const message =
        clientError?._tag === "AuthenticationFailed"
          ? "CLIProxyAPI authentication failed."
          : clientError?._tag === "CatalogMalformed"
            ? "CLIProxyAPI returned a malformed model catalog."
            : clientError?._tag === "CatalogRequestFailed"
              ? "CLIProxyAPI model catalog could not be inspected."
              : "CLIProxyAPI is configured but is not responding.";
      return unavailableSnapshot({
        checkedAt,
        installed: true,
        authStatus: "unknown",
        message,
      });
    }

    const models = toModels(result.success);
    return buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models,
      modelDiscovery: {
        status: models.length > 0 ? "live" : "empty",
        source: "cliproxyapi-claude-compatible-client",
        durationMs: 0,
      },
      probe: {
        installed: true,
        version: null,
        status: models.length > 0 ? "ready" : "warning",
        auth: { status: "authenticated", type: "local-config" },
        ...(models.length > 0
          ? {}
          : {
              message: "CLIProxyAPI returned no models for the Claude-compatible client profile.",
            }),
      },
    });
  },
);

export const CliProxyProviderLive = Layer.effect(
  CliProxyProvider,
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const lifecycle = yield* CliProxyLifecycle;
    const checkProvider = checkCliProxyProvider().pipe(
      Effect.provideService(ServerSettingsService, settings),
      Effect.provideService(CliProxyLifecycle, lifecycle),
    );
    return yield* makeManagedServerProvider({
      getSettings: settings.getSettings.pipe(
        Effect.map((value) => value.providers.cliProxy),
        Effect.orDie,
      ),
      streamSettings: settings.streamChanges.pipe(Stream.map((value) => value.providers.cliProxy)),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
      initialSnapshot: (providerSettings) =>
        providerSettings.enabled
          ? unavailableSnapshot({
              checkedAt: new Date().toISOString(),
              message: "CLIProxyAPI inspection is pending.",
            })
          : disabledSnapshot(new Date().toISOString(), "CLIProxyAPI is disabled."),
      refreshInterval: "30 seconds",
    });
  }),
);
