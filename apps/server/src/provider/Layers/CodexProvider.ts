import type { CodexSettings, ServerProviderSkill } from "@bigbud/contracts";
import {
  Cache,
  Duration,
  Effect,
  Equal,
  FileSystem,
  Layer,
  Option,
  Path,
  Result,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import {
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  parseCodexCliVersion,
} from "../codexCliVersion";
import {
  adjustCodexModelsForAccount,
  codexAuthSubLabel,
  codexAuthSubType,
  type CodexAccountSnapshot,
} from "../codexAccount";
import { probeCodexDiscovery } from "../codexAppServer";
import { CodexProvider } from "../Services/CodexProvider";
import { ServerSettingsService } from "../../ws/serverSettings";
import { ServerSettingsError } from "@bigbud/contracts";
import { BUILT_IN_MODELS, DEFAULT_CODEX_MODEL_CAPABILITIES } from "./CodexProvider.models";
import { hasCustomModelProvider, parseAuthStatusFromOutput } from "./CodexProvider.auth";

export { getCodexModelCapabilities } from "./CodexProvider.models";
export {
  parseAuthStatusFromOutput,
  readCodexConfigModelProvider,
  hasCustomModelProvider,
} from "./CodexProvider.auth";

const PROVIDER = "codex" as const;

const CAPABILITIES_PROBE_TIMEOUT_MS = 8_000;

const probeCodexCapabilities = (input: {
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly cwd: string;
}) =>
  Effect.tryPromise((signal) => probeCodexDiscovery({ ...input, signal })).pipe(
    Effect.timeoutOption(CAPABILITIES_PROBE_TIMEOUT_MS),
    Effect.result,
    Effect.map((result) => {
      if (Result.isFailure(result)) return undefined;
      return Option.isSome(result.success) ? result.success.value : undefined;
    }),
  );

const runCodexCommand = Effect.fn("runCodexCommand")(function* (args: ReadonlyArray<string>) {
  const settingsService = yield* ServerSettingsService;
  const codexSettings = yield* settingsService.getSettings.pipe(
    Effect.map((settings) => settings.providers.codex),
  );
  const command = ChildProcess.make(codexSettings.binaryPath, [...args], {
    shell: process.platform === "win32",
    env: {
      ...process.env,
      ...(codexSettings.homePath ? { CODEX_HOME: codexSettings.homePath } : {}),
    },
  });
  return yield* spawnAndCollect(codexSettings.binaryPath, command);
});

export const checkCodexProviderStatus = Effect.fn("checkCodexProviderStatus")(function* (
  resolveAccount?: (input: {
    readonly binaryPath: string;
    readonly homePath?: string;
  }) => Effect.Effect<CodexAccountSnapshot | undefined>,
  resolveSkills?: (input: {
    readonly binaryPath: string;
    readonly homePath?: string;
    readonly cwd: string;
  }) => Effect.Effect<ReadonlyArray<ServerProviderSkill> | undefined>,
): Effect.fn.Return<
  import("@bigbud/contracts").ServerProvider,
  ServerSettingsError,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | ServerSettingsService
> {
  const codexSettings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((settings) => settings.providers.codex),
  );
  const checkedAt = new Date().toISOString();
  const models = providerModelsFromSettings(
    BUILT_IN_MODELS,
    PROVIDER,
    codexSettings.customModels,
    DEFAULT_CODEX_MODEL_CAPABILITIES,
  );

  if (!codexSettings.enabled) {
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
        message: "Codex is disabled in bigbud settings.",
      },
    });
  }

  const versionProbe = yield* runCodexCommand(["--version"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      provider: PROVIDER,
      enabled: codexSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Codex CLI (`codex`) is not installed or not on PATH."
          : `Failed to execute Codex CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: codexSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Codex CLI is installed but failed to run. Timed out while running command.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion =
    parseCodexCliVersion(`${version.stdout}\n${version.stderr}`) ??
    parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
  if (version.code !== 0) {
    const detail = detailFromResult(version);
    return buildServerProvider({
      provider: PROVIDER,
      enabled: codexSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: detail
          ? `Codex CLI is installed but failed to run. ${detail}`
          : "Codex CLI is installed but failed to run.",
      },
    });
  }

  if (parsedVersion && !isCodexCliVersionSupported(parsedVersion)) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: codexSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: formatCodexCliUpgradeMessage(parsedVersion),
      },
    });
  }

  const skills =
    (resolveSkills
      ? yield* resolveSkills({
          binaryPath: codexSettings.binaryPath,
          homePath: codexSettings.homePath,
          cwd: process.cwd(),
        }).pipe(Effect.orElseSucceed(() => undefined))
      : undefined) ?? [];

  if (yield* hasCustomModelProvider) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: codexSettings.enabled,
      checkedAt,
      models,
      skills,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "ready",
        auth: { status: "unknown" },
        message: "Using a custom Codex model provider; OpenAI login check skipped.",
      },
    });
  }

  const authProbe = yield* runCodexCommand(["login", "status"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );
  const account = resolveAccount
    ? yield* resolveAccount({
        binaryPath: codexSettings.binaryPath,
        homePath: codexSettings.homePath,
      })
    : undefined;
  const resolvedModels = adjustCodexModelsForAccount(models, account);

  if (Result.isFailure(authProbe)) {
    const error = authProbe.failure;
    return buildServerProvider({
      provider: PROVIDER,
      enabled: codexSettings.enabled,
      checkedAt,
      models: resolvedModels,
      skills,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unknown" },
        message:
          error instanceof Error
            ? `Could not verify Codex authentication status: ${error.message}.`
            : "Could not verify Codex authentication status.",
      },
    });
  }

  if (Option.isNone(authProbe.success)) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: codexSettings.enabled,
      checkedAt,
      models: resolvedModels,
      skills,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unknown" },
        message: "Could not verify Codex authentication status. Timed out while running command.",
      },
    });
  }

  const parsed = parseAuthStatusFromOutput(authProbe.success.value);
  const authType = codexAuthSubType(account);
  const authLabel = codexAuthSubLabel(account);
  return buildServerProvider({
    provider: PROVIDER,
    enabled: codexSettings.enabled,
    checkedAt,
    models: resolvedModels,
    skills,
    probe: {
      installed: true,
      version: parsedVersion,
      status: parsed.status,
      auth: {
        ...parsed.auth,
        ...(authType ? { type: authType } : {}),
        ...(authLabel ? { label: authLabel } : {}),
      },
      ...(parsed.message ? { message: parsed.message } : {}),
    },
  });
});

export const CodexProviderLive = Layer.effect(
  CodexProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const accountProbeCache = yield* Cache.make({
      capacity: 4,
      timeToLive: Duration.minutes(5),
      lookup: (key: string) => {
        const [binaryPath, homePath, cwd] = JSON.parse(key) as [string, string | undefined, string];
        return probeCodexCapabilities({
          binaryPath,
          cwd,
          ...(homePath ? { homePath } : {}),
        });
      },
    });

    const getDiscovery = (input: {
      readonly binaryPath: string;
      readonly homePath?: string;
      readonly cwd: string;
    }) =>
      Cache.get(accountProbeCache, JSON.stringify([input.binaryPath, input.homePath, input.cwd]));

    const checkProvider = checkCodexProviderStatus(
      (input) =>
        getDiscovery({
          ...input,
          cwd: process.cwd(),
        }).pipe(Effect.map((discovery) => discovery?.account)),
      (input) => getDiscovery(input).pipe(Effect.map((discovery) => discovery?.skills)),
    ).pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return yield* makeManagedServerProvider<CodexSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.codex),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.codex),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
    });
  }),
);
