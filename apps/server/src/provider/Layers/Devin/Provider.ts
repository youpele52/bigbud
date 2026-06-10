import type { DevinSettings, ServerProvider, ServerSettingsError } from "@bigbud/contracts";
import { Cause, Effect, Equal, Exit, Layer, Option, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  collectStreamAsString,
  isCommandMissingCause,
  providerModelsFromSettings,
  type CommandResult,
} from "../../providerSnapshot.ts";
import { makeManagedServerProvider } from "../../makeManagedServerProvider.ts";
import { DevinProvider } from "../../Services/Devin/Provider.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import {
  ABOUT_TIMEOUT_MS,
  buildDevinProviderSnapshot,
  parseDevinVersionOutput,
} from "./Provider.about.ts";
import { hasDevinModelCapabilities } from "./Provider.config.ts";
import {
  discoverDevinModelCapabilitiesViaAcp,
  discoverDevinModelsViaAcp,
} from "./Provider.discovery.ts";
import {
  DEVIN_ACP_MODEL_DISCOVERY_TIMEOUT_MS,
  DEVIN_REFRESH_INTERVAL,
  EMPTY_CAPABILITIES,
  getDevinFallbackModels,
  PROVIDER,
} from "./Provider.shared.ts";

export {
  buildDevinCapabilitiesFromConfigOptions,
  buildDevinDiscoveredModels,
  buildDevinDiscoveredModelsFromConfigOptions,
  resolveDevinAcpBaseModelId,
  resolveDevinAcpConfigUpdates,
} from "./Provider.config.ts";
export { buildDevinProviderSnapshot, parseDevinVersionOutput } from "./Provider.about.ts";
export {
  discoverDevinModelCapabilitiesViaAcp,
  discoverDevinModelsViaAcp,
} from "./Provider.discovery.ts";
export { getDevinFallbackModels } from "./Provider.shared.ts";

function buildInitialDevinProviderSnapshot(devinSettings: DevinSettings): ServerProvider {
  const checkedAt = new Date().toISOString();
  const models = getDevinFallbackModels(devinSettings);

  if (!devinSettings.enabled) {
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
        message: "Devin is disabled in bigbud settings.",
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
      message: "Checking Devin CLI availability...",
    },
  });
}

const runDevinCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const devinSettings = yield* Effect.service(ServerSettingsService).pipe(
      Effect.flatMap((service) => service.getSettings),
      Effect.map((settings) => settings.providers.devin),
    );
    const command = ChildProcess.make(devinSettings.binaryPath, [...args], {
      shell: process.platform === "win32",
    });

    const child = yield* spawner.spawn(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

const runDevinVersionCommand = runDevinCommand(["--version"]);

export const checkDevinProviderStatus = Effect.fn("checkDevinProviderStatus")(
  function* (): Effect.fn.Return<
    ServerProvider,
    ServerSettingsError,
    ChildProcessSpawner.ChildProcessSpawner | ServerSettingsService
  > {
    const devinSettings = yield* Effect.service(ServerSettingsService).pipe(
      Effect.flatMap((service) => service.getSettings),
      Effect.map((settings) => settings.providers.devin),
    );
    const checkedAt = new Date().toISOString();
    const fallbackModels = getDevinFallbackModels(devinSettings);

    if (!devinSettings.enabled) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: false,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Devin is disabled in bigbud settings.",
        },
      });
    }

    const versionProbe = yield* runDevinVersionCommand.pipe(
      Effect.timeoutOption(ABOUT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return buildServerProvider({
        provider: PROVIDER,
        enabled: devinSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: !isCommandMissingCause(error),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(error)
            ? "Devin CLI (`devin`) is not installed or not on PATH."
            : `Failed to execute Devin CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
        },
      });
    }

    if (Option.isNone(versionProbe.success)) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: devinSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "Devin CLI is installed but timed out while running `devin --version`.",
        },
      });
    }

    const parsed = parseDevinVersionOutput(versionProbe.success.value);

    if (parsed.status === "error") {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: devinSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: parsed.version,
          status: parsed.status,
          auth: parsed.auth,
          message: parsed.message ?? "Devin CLI is not authenticated.",
        },
      });
    }

    let discoveredModels =
      Option.none<ReadonlyArray<import("@bigbud/contracts").ServerProviderModel>>();
    let discoveryWarning: string | undefined;
    if (parsed.auth.status !== "unauthenticated") {
      const discoveryExit = yield* Effect.exit(
        discoverDevinModelsViaAcp(devinSettings).pipe(
          Effect.timeoutOption(DEVIN_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
        ),
      );
      if (Exit.isFailure(discoveryExit)) {
        const prettyCause = Cause.pretty(discoveryExit.cause);
        yield* Effect.logWarning("Devin ACP model discovery failed", {
          cause: prettyCause,
        });
        discoveryWarning = "Devin ACP model discovery failed. Model switching may be limited.";
      } else if (Option.isNone(discoveryExit.value)) {
        discoveryWarning = `Devin ACP model discovery timed out after ${DEVIN_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms. Model switching may be limited.`;
      } else if (discoveryExit.value.value.length === 0) {
        discoveryWarning =
          "Devin ACP model discovery returned no built-in models. Model switching may be limited.";
      } else {
        discoveredModels = discoveryExit.value;
      }
    }

    return buildDevinProviderSnapshot({
      checkedAt,
      devinSettings,
      parsed,
      discoveredModels: Option.getOrElse(
        Option.filter(discoveredModels, (models) => models.length > 0),
        () => [] as const,
      ),
      ...(discoveryWarning ? { discoveryWarning } : {}),
    });
  },
);

export const DevinProviderLive = Layer.effect(
  DevinProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const checkProvider = checkDevinProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return yield* makeManagedServerProvider<DevinSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.devin),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.devin),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      initialSnapshot: buildInitialDevinProviderSnapshot,
      checkProvider,
      enrichSnapshot: ({ settings, snapshot, publishSnapshot }) => {
        if (
          !settings.enabled ||
          snapshot.auth.status === "unauthenticated" ||
          !snapshot.models.some((model) => !model.isCustom && !hasDevinModelCapabilities(model))
        ) {
          return Effect.void;
        }

        return discoverDevinModelCapabilitiesViaAcp(settings, snapshot.models).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.flatMap((discoveredModels) => {
            if (discoveredModels.length === 0) {
              return Effect.void;
            }

            return publishSnapshot({
              ...snapshot,
              models: providerModelsFromSettings(
                discoveredModels,
                PROVIDER,
                settings.customModels,
                EMPTY_CAPABILITIES,
              ),
            });
          }),
          Effect.catchCause((cause) =>
            Effect.logWarning("Devin ACP background capability enrichment failed", {
              models: snapshot.models.map((model) => model.slug),
              cause: Cause.pretty(cause),
            }).pipe(Effect.asVoid),
          ),
        );
      },
      refreshInterval: DEVIN_REFRESH_INTERVAL,
    });
  }),
);
