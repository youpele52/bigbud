import type {
  ModelCapabilities,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderFailure,
  ServerProviderModel,
  ServerProviderModelDiscovery,
  ServerProviderSkill,
  ServerProviderSlashCommand,
  ServerProviderState,
} from "@bigbud/contracts";
import { compareCodexCliVersions, MINIMUM_CODEX_CLI_VERSION } from "./codexCliVersion.ts";
import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { normalizeModelSlug } from "@bigbud/shared/model";
import { isWindowsCommandNotFound } from "../utils/processRunner";

export const DEFAULT_TIMEOUT_MS = 4_000;
// Auth status checks involve disk/network lookups and can be slow on first run
export const AUTH_PROBE_TIMEOUT_MS = 10_000;

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface ProviderProbeResult {
  readonly installed: boolean;
  readonly version: string | null;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProviderAuth;
  readonly message?: string;
  readonly failure?: ServerProviderFailure;
}

export function classifyProviderFailure(input: {
  readonly enabled: boolean;
  readonly probe: ProviderProbeResult;
}): ServerProviderFailure | undefined {
  if (!input.enabled || input.probe.status !== "error") return undefined;
  if (input.probe.failure) return input.probe.failure;
  if (!input.probe.installed) {
    return { classification: "user-action-required", reason: "command-not-found" };
  }
  if (input.probe.auth.status === "unauthenticated") {
    return { classification: "user-action-required", reason: "authentication-required" };
  }
  return { classification: "retryable", reason: "process-failed" };
}

export function classifyProviderExecutionFailure(input: {
  readonly message: string;
  readonly binaryPath: string;
  readonly defaultBinaryPath: string;
}): ServerProviderFailure {
  const message = input.message.toLowerCase();
  if (message.includes("enoent") || message.includes("not found")) {
    return {
      classification: "user-action-required",
      reason:
        input.binaryPath === input.defaultBinaryPath ? "command-not-found" : "invalid-binary-path",
    };
  }
  if (message.includes("econnrefused") || message.includes("connection refused")) {
    return { classification: "retryable", reason: "connection-refused" };
  }
  return { classification: "retryable", reason: "process-failed" };
}

export function nonEmptyTrimmed(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isCommandMissingCause(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const lower = error.message.toLowerCase();
  return lower.includes("enoent") || lower.includes("notfound");
}

export const spawnAndCollect = (binaryPath: string, command: ChildProcess.Command) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    const result: CommandResult = { stdout, stderr, code: exitCode };
    if (isWindowsCommandNotFound(exitCode, stderr)) {
      return yield* Effect.fail(new Error(`spawn ${binaryPath} ENOENT`));
    }
    return result;
  }).pipe(Effect.scoped);

export function detailFromResult(
  result: CommandResult & { readonly timedOut?: boolean },
): string | undefined {
  if (result.timedOut) return "Timed out while running command.";
  const stderr = nonEmptyTrimmed(result.stderr);
  if (stderr) return stderr;
  const stdout = nonEmptyTrimmed(result.stdout);
  if (stdout) return stdout;
  if (result.code !== 0) {
    return `Command exited with code ${result.code}.`;
  }
  return undefined;
}

export function extractAuthBoolean(value: unknown): boolean | undefined {
  if (globalThis.Array.isArray(value)) {
    for (const entry of value) {
      const nested = extractAuthBoolean(entry);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }

  if (!value || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ["authenticated", "isAuthenticated", "loggedIn", "isLoggedIn"] as const) {
    if (typeof record[key] === "boolean") return record[key];
  }
  for (const key of ["auth", "status", "session", "account"] as const) {
    const nested = extractAuthBoolean(record[key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

export function parseGenericCliVersion(output: string): string | null {
  const match = output.match(/\b(\d+\.\d+\.\d+)\b/);
  return match?.[1] ?? null;
}

export function providerModelsFromSettings(
  builtInModels: ReadonlyArray<ServerProviderModel>,
  provider: ServerProvider["provider"],
  customModels: ReadonlyArray<string>,
  customModelCapabilities: ModelCapabilities,
): ReadonlyArray<ServerProviderModel> {
  const resolvedBuiltInModels = [...builtInModels];
  const seen = new Set(resolvedBuiltInModels.map((model) => model.slug));
  const customEntries: ServerProviderModel[] = [];

  for (const candidate of customModels) {
    const normalized = normalizeModelSlug(candidate, provider);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    customEntries.push({
      slug: normalized,
      name: normalized,
      isCustom: true,
      capabilities: customModelCapabilities,
    });
  }

  return [...resolvedBuiltInModels, ...customEntries];
}

export function buildServerProvider(input: {
  provider: ServerProvider["provider"];
  enabled: boolean;
  checkedAt: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelDiscovery?: ServerProviderModelDiscovery;
  slashCommands?: ReadonlyArray<ServerProviderSlashCommand>;
  skills?: ReadonlyArray<ServerProviderSkill>;
  supportsSteer?: boolean;
  probe: ProviderProbeResult;
}): ServerProvider {
  const nativeSteer =
    input.provider === "pi" ||
    (input.provider === "codex" &&
      input.probe.version !== null &&
      compareCodexCliVersions(input.probe.version, MINIMUM_CODEX_CLI_VERSION) >= 0);
  return {
    provider: input.provider,
    enabled: input.enabled,
    installed: input.probe.installed,
    version: input.probe.version,
    status: input.enabled ? input.probe.status : "disabled",
    auth: input.probe.auth,
    checkedAt: input.checkedAt,
    initialProbeComplete: true,
    ...(input.probe.message ? { message: input.probe.message } : {}),
    ...(classifyProviderFailure(input) ? { failure: classifyProviderFailure(input) } : {}),
    models: input.models,
    ...(input.modelDiscovery ? { modelDiscovery: input.modelDiscovery } : {}),
    slashCommands: [...(input.slashCommands ?? [])],
    skills: [...(input.skills ?? [])],
    // App-level steering is universal; providers without native steering use
    // the explicit interrupt-and-continue strategy.
    supportsSteer: true,
    turnControl: {
      nativeSteer,
      interruptTarget: input.provider === "codex" ? "exact-turn" : "current-session",
      activeTurnInspection: "unavailable",
      continuation: true,
    },
  };
}

export function buildInstalledProviderAvailability(input: {
  readonly provider: ServerProvider["provider"];
  readonly version: string;
  readonly checkedAt: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly message: string;
  readonly modelDiscovery?: ServerProviderModelDiscovery;
}): ServerProvider {
  return buildServerProvider({
    provider: input.provider,
    enabled: true,
    checkedAt: input.checkedAt,
    models: input.models,
    ...(input.modelDiscovery ? { modelDiscovery: input.modelDiscovery } : {}),
    probe: {
      installed: true,
      version: input.version,
      status: "ready",
      auth: { status: "unknown" },
      message: input.message,
    },
  });
}

export const collectStreamAsString = <E>(
  stream: Stream.Stream<Uint8Array, E>,
): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );
