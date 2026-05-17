import type { CursorSettings, ServerProvider, ServerSettingsError } from "@bigbud/contracts";
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
import { CursorProvider } from "../../Services/Cursor/Provider.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import {
  ABOUT_TIMEOUT_MS,
  buildCursorProviderSnapshot,
  getCursorParameterizedModelPickerUnsupportedMessage,
  isCursorAboutJsonFormatUnsupported,
  parseCursorAboutOutput,
  readCursorCliConfigChannel,
} from "./Provider.about.ts";
import { hasCursorModelCapabilities } from "./Provider.config.ts";
import {
  discoverCursorModelCapabilitiesViaAcp,
  discoverCursorModelsViaAcp,
} from "./Provider.discovery.ts";
import {
  CURSOR_ACP_MODEL_DISCOVERY_TIMEOUT_MS,
  CURSOR_REFRESH_INTERVAL,
  EMPTY_CAPABILITIES,
  getCursorFallbackModels,
  PROVIDER,
} from "./Provider.shared.ts";

export {
  CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
  CURSOR_PARAMETERIZED_MODEL_PICKER_MIN_VERSION_DATE,
} from "./Provider.shared.ts";
export {
  buildCursorCapabilitiesFromConfigOptions,
  buildCursorDiscoveredModelsFromConfigOptions,
  resolveCursorAcpBaseModelId,
  resolveCursorAcpConfigUpdates,
} from "./Provider.config.ts";
export {
  buildCursorProviderSnapshot,
  getCursorParameterizedModelPickerUnsupportedMessage,
  parseCursorAboutOutput,
  parseCursorCliConfigChannel,
  parseCursorVersionDate,
} from "./Provider.about.ts";
export {
  discoverCursorModelCapabilitiesViaAcp,
  discoverCursorModelsViaAcp,
} from "./Provider.discovery.ts";
export { getCursorFallbackModels } from "./Provider.shared.ts";

function buildInitialCursorProviderSnapshot(cursorSettings: CursorSettings): ServerProvider {
  const checkedAt = new Date().toISOString();
  const models = getCursorFallbackModels(cursorSettings);

  if (!cursorSettings.enabled) {
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
        message: "Cursor is disabled in bigbud settings.",
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
      message: "Checking Cursor Agent availability...",
    },
  });
}

const runCursorCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const cursorSettings = yield* Effect.service(ServerSettingsService).pipe(
      Effect.flatMap((service) => service.getSettings),
      Effect.map((settings) => settings.providers.cursor),
    );
    const command = ChildProcess.make(cursorSettings.binaryPath, [...args], {
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

const runCursorAboutCommand = Effect.gen(function* () {
  const jsonResult = yield* runCursorCommand(["about", "--format", "json"]);
  if (!isCursorAboutJsonFormatUnsupported(jsonResult)) {
    return jsonResult;
  }
  return yield* runCursorCommand(["about"]);
});

export const checkCursorProviderStatus = Effect.fn("checkCursorProviderStatus")(
  function* (): Effect.fn.Return<
    ServerProvider,
    ServerSettingsError,
    ChildProcessSpawner.ChildProcessSpawner | ServerSettingsService
  > {
    const cursorSettings = yield* Effect.service(ServerSettingsService).pipe(
      Effect.flatMap((service) => service.getSettings),
      Effect.map((settings) => settings.providers.cursor),
    );
    const checkedAt = new Date().toISOString();
    const fallbackModels = getCursorFallbackModels(cursorSettings);

    if (!cursorSettings.enabled) {
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
          message: "Cursor is disabled in bigbud settings.",
        },
      });
    }

    const aboutProbe = yield* runCursorAboutCommand.pipe(
      Effect.timeoutOption(ABOUT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(aboutProbe)) {
      const error = aboutProbe.failure;
      return buildServerProvider({
        provider: PROVIDER,
        enabled: cursorSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: !isCommandMissingCause(error),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(error)
            ? "Cursor Agent CLI (`agent`) is not installed or not on PATH."
            : `Failed to execute Cursor Agent CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
        },
      });
    }

    if (Option.isNone(aboutProbe.success)) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: cursorSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "Cursor Agent CLI is installed but timed out while running `agent about`.",
        },
      });
    }

    const parsed = parseCursorAboutOutput(aboutProbe.success.value);
    const parameterizedModelPickerUnsupportedMessage =
      getCursorParameterizedModelPickerUnsupportedMessage({
        version: parsed.version,
        channel: readCursorCliConfigChannel(),
      });
    if (parameterizedModelPickerUnsupportedMessage) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: cursorSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: parsed.version,
          status: "error",
          auth: parsed.auth,
          message:
            parsed.auth.status === "unauthenticated" && parsed.message
              ? `${parameterizedModelPickerUnsupportedMessage} ${parsed.message}`
              : parameterizedModelPickerUnsupportedMessage,
        },
      });
    }

    let discoveredModels =
      Option.none<ReadonlyArray<import("@bigbud/contracts").ServerProviderModel>>();
    let discoveryWarning: string | undefined;
    if (parsed.auth.status !== "unauthenticated") {
      const discoveryExit = yield* Effect.exit(
        discoverCursorModelsViaAcp(cursorSettings).pipe(
          Effect.timeoutOption(CURSOR_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
        ),
      );
      if (Exit.isFailure(discoveryExit)) {
        const prettyCause = Cause.pretty(discoveryExit.cause);
        yield* Effect.logWarning("Cursor ACP model discovery failed", {
          cause: prettyCause,
        });
        discoveryWarning = "Cursor ACP model discovery failed. Check server logs for details.";
      } else if (Option.isNone(discoveryExit.value)) {
        discoveryWarning = `Cursor ACP model discovery timed out after ${CURSOR_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`;
      } else if (discoveryExit.value.value.length === 0) {
        discoveryWarning = "Cursor ACP model discovery returned no built-in models.";
      } else {
        discoveredModels = discoveryExit.value;
      }
    }

    return buildCursorProviderSnapshot({
      checkedAt,
      cursorSettings,
      parsed,
      discoveredModels: Option.getOrElse(
        Option.filter(discoveredModels, (models) => models.length > 0),
        () => [] as const,
      ),
      ...(discoveryWarning ? { discoveryWarning } : {}),
    });
  },
);

export const CursorProviderLive = Layer.effect(
  CursorProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const checkProvider = checkCursorProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return yield* makeManagedServerProvider<CursorSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.cursor),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.cursor),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      initialSnapshot: buildInitialCursorProviderSnapshot,
      checkProvider,
      enrichSnapshot: ({ settings, snapshot, publishSnapshot }) => {
        if (
          !settings.enabled ||
          snapshot.auth.status === "unauthenticated" ||
          !snapshot.models.some((model) => !model.isCustom && !hasCursorModelCapabilities(model))
        ) {
          return Effect.void;
        }

        return discoverCursorModelCapabilitiesViaAcp(settings, snapshot.models).pipe(
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
            Effect.logWarning("Cursor ACP background capability enrichment failed", {
              models: snapshot.models.map((model) => model.slug),
              cause: Cause.pretty(cause),
            }).pipe(Effect.asVoid),
          ),
        );
      },
      refreshInterval: CURSOR_REFRESH_INTERVAL,
    });
  }),
);
