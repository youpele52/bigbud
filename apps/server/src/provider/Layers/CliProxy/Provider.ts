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
import {
  cliProxyDiagnostic,
  diagnosticForClientError,
  diagnosticForCommandResult,
  diagnosticForConfigError,
} from "./Diagnostic.ts";
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

function disabledSnapshot(checkedAt: string): ServerProvider {
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
    },
  });
}

function pendingSnapshot(checkedAt: string): ServerProvider {
  return buildServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models: [],
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown", type: "local-config" },
    },
  });
}

function unavailableSnapshot(input: {
  readonly checkedAt: string;
  readonly diagnostic: NonNullable<ServerProvider["cliProxyDiagnostic"]>;
  readonly installed?: boolean;
  readonly authStatus?: "authenticated" | "unknown";
}): ServerProvider {
  return {
    ...buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt: input.checkedAt,
      models: [],
      probe: {
        installed: input.installed ?? false,
        version: null,
        status: "warning",
        auth: { status: input.authStatus ?? "unknown", type: "local-config" },
      },
    }),
    cliProxyDiagnostic: input.diagnostic,
  };
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
      return disabledSnapshot(checkedAt);
    }

    const configResult = attemptConfigResolution(cliProxySettings.configPath || undefined);
    if (configResult._tag === "failure") {
      return unavailableSnapshot({
        checkedAt,
        diagnostic:
          configResult.cause instanceof CliProxyConfigError
            ? diagnosticForConfigError(configResult.cause)
            : cliProxyDiagnostic("configuration-invalid"),
      });
    }

    const claudeRunnable = yield* Effect.tryPromise(() =>
      lifecycle.isClaudeRunnable({ binaryPath: providerSettings.providers.claudeAgent.binaryPath }),
    ).pipe(Effect.result);
    if (claudeRunnable._tag === "Failure") {
      return unavailableSnapshot({
        checkedAt,
        installed: true,
        diagnostic: cliProxyDiagnostic("claude-cli-unavailable"),
      });
    }
    if (claudeRunnable.success._tag !== "available") {
      return unavailableSnapshot({
        checkedAt,
        installed: true,
        diagnostic: diagnosticForCommandResult(claudeRunnable.success),
      });
    }

    const result = yield* Effect.tryPromise(() => inspectCliProxy(configResult.config)).pipe(
      Effect.result,
    );
    if (result._tag === "Failure") {
      const failure: unknown = result.failure;
      return unavailableSnapshot({
        checkedAt,
        installed: true,
        authStatus: "unknown",
        diagnostic:
          failure instanceof CliProxyClientError
            ? diagnosticForClientError(failure)
            : cliProxyDiagnostic("activation-unavailable"),
      });
    }

    const models = toModels(result.success);
    const snapshot = buildServerProvider({
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
      },
    });
    return models.length > 0
      ? snapshot
      : { ...snapshot, cliProxyDiagnostic: cliProxyDiagnostic("catalog-empty") };
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
          ? pendingSnapshot(new Date().toISOString())
          : disabledSnapshot(new Date().toISOString()),
      refreshInterval: "30 seconds",
    });
  }),
);
