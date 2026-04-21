import type { PiSettings, ServerProvider } from "@bigbud/contracts";
import { ServerSettingsError } from "@bigbud/contracts";
import { Effect, Equal, Layer, Option, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { makeManagedServerProvider } from "../makeManagedServerProvider";
import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot";
import { ProviderValidationError } from "../Errors.ts";
import { PiProvider } from "../Services/PiProvider";
import { ServerSettingsService } from "../../ws/serverSettings";
import {
  createPiRpcProcess,
  type PiRpcModel,
  type PiRpcSessionState,
  type PiRpcSlashCommand,
} from "./PiRpcProcess.ts";
import { resolvePiInvocation } from "./PiCli.ts";
import { toMessage } from "./PiAdapter.utils.ts";
import {
  buildPiModels,
  buildPiSkills,
  EMPTY_MODEL_CAPABILITIES,
  inferPiAuthStatus,
  mapPiSlashCommands,
} from "./PiProvider.utils.ts";

const PROVIDER = "pi" as const;

const runPiCommand = Effect.fn("runPiCommand")(function* (
  binaryPath: string,
  args: ReadonlyArray<string>,
) {
  const invocation = resolvePiInvocation(binaryPath);
  const command = ChildProcess.make(invocation.command, [...invocation.args, ...args], {
    shell: process.platform === "win32",
  });
  return yield* spawnAndCollect(invocation.command, command);
});

export interface PiRpcProbeResult {
  readonly state: PiRpcSessionState | null;
  readonly models: ReadonlyArray<PiRpcModel>;
  readonly commands: ReadonlyArray<PiRpcSlashCommand>;
}

export const probePiRpc = Effect.fn("probePiRpc")(function* (binaryPath: string) {
  const rpc = yield* Effect.tryPromise({
    try: () =>
      createPiRpcProcess({
        binaryPath,
        cwd: process.cwd(),
        env: process.env,
      }),
    catch: (cause) =>
      new ProviderValidationError({
        operation: "probePiRpc",
        issue: toMessage(cause, "Failed to start Pi RPC process for provider probe."),
        cause,
      }),
  });

  return yield* Effect.acquireUseRelease(
    Effect.succeed(rpc),
    (process) =>
      Effect.tryPromise({
        try: async () => {
          const state = await process.request<PiRpcSessionState>({ type: "get_state" });
          const models = await process.request<{ models: ReadonlyArray<PiRpcModel> }>({
            type: "get_available_models",
          });
          const commands = await process.request<{ commands: ReadonlyArray<PiRpcSlashCommand> }>({
            type: "get_commands",
          });
          return {
            state: state.data ?? null,
            models: models.data?.models ?? [],
            commands: commands.data?.commands ?? [],
          } satisfies PiRpcProbeResult;
        },
        catch: (cause) =>
          new ProviderValidationError({
            operation: "probePiRpc",
            issue: toMessage(cause, "Failed to query Pi RPC provider state."),
            cause,
          }),
      }),
    (process) => Effect.promise(() => process.stop()).pipe(Effect.orElseSucceed(() => undefined)),
  );
});

function makeInitialPiSnapshot(settings: PiSettings): ServerProvider {
  const checkedAt = new Date().toISOString();
  const models = providerModelsFromSettings(
    [],
    PROVIDER,
    settings.customModels,
    EMPTY_MODEL_CAPABILITIES,
  );

  if (!settings.enabled) {
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
        message: "Pi is disabled in bigbud settings.",
      },
    });
  }

  return buildServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Checking Pi availability...",
    },
  });
}

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  probeRpc: (
    binaryPath: string,
  ) => Effect.Effect<PiRpcProbeResult, ProviderValidationError> = probePiRpc,
): Effect.fn.Return<
  ServerProvider,
  ServerSettingsError,
  ChildProcessSpawner.ChildProcessSpawner | ServerSettingsService
> {
  const piSettings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((settings) => settings.providers.pi),
  );
  const checkedAt = new Date().toISOString();
  const fallbackModels = providerModelsFromSettings(
    [],
    PROVIDER,
    piSettings.customModels,
    EMPTY_MODEL_CAPABILITIES,
  );

  if (!piSettings.enabled) {
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
        message: "Pi is disabled in bigbud settings.",
      },
    });
  }

  const versionProbe = yield* runPiCommand(piSettings.binaryPath, ["--version"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    const message = isCommandMissingCause(error)
      ? "Pi CLI (`pi`) is not installed or not on PATH."
      : `Failed to execute Pi CLI health check: ${error instanceof Error ? error.message : String(error)}.`;
    yield* Effect.logWarning("Pi provider probe failed", { reason: "version-check", message });
    return buildServerProvider({
      provider: PROVIDER,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message,
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    const message = "Pi CLI is installed but failed to run. Timed out while running command.";
    yield* Effect.logWarning("Pi provider probe failed", { reason: "version-timeout", message });
    return buildServerProvider({
      provider: PROVIDER,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message,
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
  if (version.code !== 0) {
    const detail = detailFromResult(version);
    return buildServerProvider({
      provider: PROVIDER,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: detail
          ? `Pi CLI is installed but failed to run. ${detail}`
          : "Pi CLI is installed but failed to run.",
      },
    });
  }

  const rpcProbe = yield* probeRpc(piSettings.binaryPath).pipe(Effect.result);
  if (Result.isFailure(rpcProbe)) {
    const detail = rpcProbe.failure.message;
    const authStatus = inferPiAuthStatus({ models: [], detail });
    yield* Effect.logWarning("Pi RPC probe failed", {
      reason: "rpc-probe",
      auth: authStatus.auth,
      message: authStatus.message,
    });
    return buildServerProvider({
      provider: PROVIDER,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: authStatus.status,
        auth: { status: authStatus.auth },
        ...(authStatus.message ? { message: authStatus.message } : {}),
      },
    });
  }

  const probedModels = buildPiModels(rpcProbe.success.models, piSettings.customModels);
  const slashCommands = mapPiSlashCommands(rpcProbe.success.commands);
  const skills = buildPiSkills(rpcProbe.success.commands);
  const authStatus = inferPiAuthStatus({ models: rpcProbe.success.models });
  const currentModel = rpcProbe.success.state?.model;
  const message =
    authStatus.message ??
    (currentModel ? `Pi is ready using ${currentModel.provider}/${currentModel.id}.` : undefined);

  return buildServerProvider({
    provider: PROVIDER,
    enabled: piSettings.enabled,
    checkedAt,
    models: probedModels,
    slashCommands,
    skills,
    probe: {
      installed: true,
      version: parsedVersion,
      status: authStatus.status,
      auth: { status: authStatus.auth },
      ...(message ? { message } : {}),
    },
  });
});

export const PiProviderLive = Layer.effect(
  PiProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const initialSettings = yield* serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.providers.pi),
    );

    const checkProvider = checkPiProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return yield* makeManagedServerProvider<PiSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.pi),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.pi),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
      initialSnapshot: makeInitialPiSnapshot(initialSettings),
    });
  }),
);
