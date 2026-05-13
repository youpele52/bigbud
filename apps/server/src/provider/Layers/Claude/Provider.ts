import type {
  ClaudeSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderModel,
  ServerProviderSlashCommand,
} from "@bigbud/contracts";
import { Cache, Duration, Effect, Equal, Layer, Option, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  query as claudeQuery,
  type SlashCommand as ClaudeSlashCommand,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import {
  buildServerProvider,
  AUTH_PROBE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../../providerSnapshot";
import { makeManagedServerProvider } from "../../makeManagedServerProvider";
import { ClaudeProvider } from "../../Services/Claude/Provider";
import { ServerSettingsService } from "../../../ws/serverSettings";
import { ServerSettingsError } from "@bigbud/contracts";
import {
  claudeAuthMetadata,
  extractClaudeAuthMethodFromOutput,
  extractSubscriptionTypeFromOutput,
  parseClaudeAuthStatusFromOutput,
} from "./ProviderAuth";

const DEFAULT_CLAUDE_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

const PROVIDER = "claudeAgent" as const;
const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High", isDefault: true },
        { value: "max", label: "Max" },
        { value: "ultrathink", label: "Ultrathink" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [
        { value: "200k", label: "200k", isDefault: true },
        { value: "1m", label: "1M" },
      ],
      promptInjectedEffortLevels: ["ultrathink"],
    } satisfies ModelCapabilities,
  },
  {
    slug: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High", isDefault: true },
        { value: "ultrathink", label: "Ultrathink" },
      ],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [
        { value: "200k", label: "200k", isDefault: true },
        { value: "1m", label: "1M" },
      ],
      promptInjectedEffortLevels: ["ultrathink"],
    } satisfies ModelCapabilities,
  },
  {
    slug: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High", isDefault: true },
        { value: "max", label: "Max" },
        { value: "ultrathink", label: "Ultrathink" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [
        { value: "200k", label: "200k", isDefault: true },
        { value: "1m", label: "1M" },
      ],
      promptInjectedEffortLevels: ["ultrathink"],
    } satisfies ModelCapabilities,
  },
  {
    slug: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [],
      supportsFastMode: false,
      supportsThinkingToggle: true,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    } satisfies ModelCapabilities,
  },
];

export function getClaudeModelCapabilities(model: string | null | undefined): ModelCapabilities {
  const slug = model?.trim();
  return (
    BUILT_IN_MODELS.find((candidate) => candidate.slug === slug)?.capabilities ??
    DEFAULT_CLAUDE_MODEL_CAPABILITIES
  );
}

// Re-export for external consumers that imported these from this module.
export { parseClaudeAuthStatusFromOutput } from "./ProviderAuth";

const CAPABILITIES_PROBE_TIMEOUT_MS = 8_000;

function nonEmptyProbeString(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function dedupeSlashCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const commandsByName = new Map<string, ServerProviderSlashCommand>();

  for (const command of commands) {
    const name = nonEmptyProbeString(command.name);
    if (!name) {
      continue;
    }

    const key = name.toLowerCase();
    const existing = commandsByName.get(key);
    if (!existing) {
      commandsByName.set(key, { ...command, name });
      continue;
    }

    commandsByName.set(key, {
      ...existing,
      ...(existing.description
        ? {}
        : command.description
          ? { description: command.description }
          : {}),
      ...(existing.input?.hint
        ? {}
        : command.input?.hint
          ? { input: { hint: command.input.hint } }
          : {}),
    });
  }

  return [...commandsByName.values()];
}

function parseClaudeInitializationCommands(
  commands: ReadonlyArray<ClaudeSlashCommand> | undefined,
): ReadonlyArray<ServerProviderSlashCommand> {
  return dedupeSlashCommands(
    (commands ?? []).flatMap((command) => {
      const name = nonEmptyProbeString(command.name);
      if (!name) {
        return [];
      }

      const description = nonEmptyProbeString(command.description);
      const argumentHint = nonEmptyProbeString(command.argumentHint);

      return [
        {
          name,
          ...(description ? { description } : {}),
          ...(argumentHint ? { input: { hint: argumentHint } } : {}),
        } satisfies ServerProviderSlashCommand,
      ];
    }),
  );
}

function waitForAbortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Probe account information by spawning a lightweight Claude Agent SDK
 * session and reading the initialization result.
 *
 * We pass a never-yielding AsyncIterable as the prompt so that no user
 * message is ever written to the subprocess stdin. This means the Claude
 * Code subprocess completes its local initialization IPC (returning
 * account info and slash commands) but never starts an API request to
 * Anthropic. We read the init data and then abort the subprocess.
 *
 * This is used as a fallback when `claude auth status` does not include
 * subscription type information.
 */
const probeClaudeCapabilities = (binaryPath: string) =>
  Effect.tryPromise(async () => {
    const abortController = new AbortController();
    const queryRuntime = claudeQuery({
      // Never yield — we only need initialization data, not a conversation.
      // This prevents any prompt from reaching the Anthropic API.
      // oxlint-disable-next-line require-yield
      prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
        await waitForAbortSignal(abortController.signal);
      })(),
      options: {
        pathToClaudeCodeExecutable: binaryPath,
        abortController,
        settingSources: ["user", "project", "local"],
        allowedTools: [],
        stderr: () => {},
      },
    });

    try {
      const init = await queryRuntime.initializationResult();
      return {
        subscriptionType: init.account?.subscriptionType,
        slashCommands: parseClaudeInitializationCommands(init.commands),
      };
    } finally {
      abortController.abort();
      queryRuntime.close();
    }
  }).pipe(Effect.timeout(CAPABILITIES_PROBE_TIMEOUT_MS));

const runClaudeCommand = Effect.fn("runClaudeCommand")(function* (args: ReadonlyArray<string>) {
  const claudeSettings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((settings) => settings.providers.claudeAgent),
  );
  const command = ChildProcess.make(claudeSettings.binaryPath, [...args], {
    shell: process.platform === "win32",
  });
  return yield* spawnAndCollect(claudeSettings.binaryPath, command);
});

export const checkClaudeProviderStatus = Effect.fn("checkClaudeProviderStatus")(function* (
  resolveSubscriptionType?: (binaryPath: string) => Effect.Effect<string | undefined>,
  resolveSlashCommands?: (
    binaryPath: string,
  ) => Effect.Effect<ReadonlyArray<ServerProviderSlashCommand> | undefined>,
): Effect.fn.Return<
  ServerProvider,
  ServerSettingsError,
  ChildProcessSpawner.ChildProcessSpawner | ServerSettingsService
> {
  const claudeSettings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((settings) => settings.providers.claudeAgent),
  );
  const checkedAt = new Date().toISOString();
  const models = providerModelsFromSettings(
    BUILT_IN_MODELS,
    PROVIDER,
    claudeSettings.customModels,
    DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  );

  if (!claudeSettings.enabled) {
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
        message: "Claude is disabled in bigbud settings.",
      },
    });
  }

  const versionProbe = yield* runClaudeCommand(["--version"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      provider: PROVIDER,
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Claude Agent CLI (`claude`) is not installed or not on PATH."
          : `Failed to execute Claude Agent CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Claude Agent CLI is installed but failed to run. Timed out while running command.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
  if (version.code !== 0) {
    const detail = detailFromResult(version);
    return buildServerProvider({
      provider: PROVIDER,
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: detail
          ? `Claude Agent CLI is installed but failed to run. ${detail}`
          : "Claude Agent CLI is installed but failed to run.",
      },
    });
  }

  const slashCommands =
    (resolveSlashCommands
      ? yield* resolveSlashCommands(claudeSettings.binaryPath).pipe(
          Effect.orElseSucceed(() => undefined),
        )
      : undefined) ?? [];
  const dedupedSlashCommands = dedupeSlashCommands(slashCommands);

  // ── Auth check + subscription detection ────────────────────────────

  const authProbe = yield* runClaudeCommand(["auth", "status"]).pipe(
    Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  let subscriptionType: string | undefined;
  let authMethod: string | undefined;

  if (resolveSubscriptionType) {
    subscriptionType = yield* resolveSubscriptionType(claudeSettings.binaryPath).pipe(
      Effect.orElseSucceed(() => undefined),
    );
  }

  if (!subscriptionType && Result.isSuccess(authProbe) && Option.isSome(authProbe.success)) {
    subscriptionType = extractSubscriptionTypeFromOutput(authProbe.success.value);
    authMethod = extractClaudeAuthMethodFromOutput(authProbe.success.value);
  } else if (Result.isSuccess(authProbe) && Option.isSome(authProbe.success)) {
    authMethod = extractClaudeAuthMethodFromOutput(authProbe.success.value);
  }

  if (Result.isFailure(authProbe)) {
    const error = authProbe.failure;
    return buildServerProvider({
      provider: PROVIDER,
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      slashCommands: dedupedSlashCommands,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unknown" },
        message:
          error instanceof Error
            ? `Could not verify Claude authentication status: ${error.message}.`
            : "Could not verify Claude authentication status.",
      },
    });
  }

  if (Option.isNone(authProbe.success)) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      slashCommands: dedupedSlashCommands,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unknown" },
        message: "Could not verify Claude authentication status. Timed out while running command.",
      },
    });
  }

  const parsed = parseClaudeAuthStatusFromOutput(authProbe.success.value);
  const authMetadata = claudeAuthMetadata({ subscriptionType, authMethod });
  return buildServerProvider({
    provider: PROVIDER,
    enabled: claudeSettings.enabled,
    checkedAt,
    models,
    slashCommands: dedupedSlashCommands,
    probe: {
      installed: true,
      version: parsedVersion,
      status: parsed.status,
      auth: {
        ...parsed.auth,
        ...(authMetadata ? authMetadata : {}),
      },
      ...(parsed.message ? { message: parsed.message } : {}),
    },
  });
});

export const ClaudeProviderLive = Layer.effect(
  ClaudeProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const capabilitiesProbeCache = yield* Cache.make({
      capacity: 1,
      timeToLive: Duration.minutes(5),
      lookup: (binaryPath: string) => probeClaudeCapabilities(binaryPath).pipe(Effect.option),
    });

    const checkProvider = checkClaudeProviderStatus(
      (binaryPath) =>
        Cache.get(capabilitiesProbeCache, binaryPath).pipe(
          Effect.map((result) =>
            Option.isSome(result) ? result.value.subscriptionType : undefined,
          ),
        ),
      (binaryPath) =>
        Cache.get(capabilitiesProbeCache, binaryPath).pipe(
          Effect.map((result) => (Option.isSome(result) ? result.value.slashCommands : undefined)),
        ),
    ).pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return yield* makeManagedServerProvider<ClaudeSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.claudeAgent),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.claudeAgent),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
    });
  }),
);
