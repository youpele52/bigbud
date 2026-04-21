/**
 * Codex CLI authentication status helpers.
 *
 * Reads `codex login status` output and parses auth state.
 * Also reads the Codex config.toml to detect custom model providers.
 *
 * @module CodexProvider.auth
 */
import * as OS from "node:os";
import type { ServerProviderAuth, ServerProviderState } from "@bigbud/contracts";
import { Effect, FileSystem, Path } from "effect";

import { detailFromResult, extractAuthBoolean, type CommandResult } from "../providerSnapshot";
import { ServerSettingsService } from "../../ws/serverSettings";

const OPENAI_AUTH_PROVIDERS = new Set(["openai"]);

export function parseAuthStatusFromOutput(result: CommandResult): {
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: Pick<ServerProviderAuth, "status">;
  readonly message?: string;
} {
  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();

  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      status: "warning",
      auth: { status: "unknown" },
      message: "Codex CLI authentication status command is unavailable in this Codex version.",
    };
  }

  if (
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("authentication required") ||
    lowerOutput.includes("run `codex login`") ||
    lowerOutput.includes("run codex login")
  ) {
    return {
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }

  const parsedAuth = (() => {
    const trimmed = result.stdout.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
    try {
      return {
        attemptedJsonParse: true as const,
        auth: extractAuthBoolean(JSON.parse(trimmed)),
      };
    } catch {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
  })();

  if (parsedAuth.auth === true) {
    return { status: "ready", auth: { status: "authenticated" } };
  }
  if (parsedAuth.auth === false) {
    return {
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }
  if (parsedAuth.attemptedJsonParse) {
    return {
      status: "warning",
      auth: { status: "unknown" },
      message:
        "Could not verify Codex authentication status from JSON output (missing auth marker).",
    };
  }
  if (result.code === 0) {
    return { status: "ready", auth: { status: "authenticated" } };
  }

  const detail = detailFromResult(result);
  return {
    status: "warning",
    auth: { status: "unknown" },
    message: detail
      ? `Could not verify Codex authentication status. ${detail}`
      : "Could not verify Codex authentication status.",
  };
}

/** Reads `model_provider` from `~/.codex/config.toml` (or the configured CODEX_HOME). */
export const readCodexConfigModelProvider = Effect.fn("readCodexConfigModelProvider")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settingsService = yield* ServerSettingsService;
  const codexHome = yield* settingsService.getSettings.pipe(
    Effect.map(
      (settings) =>
        settings.providers.codex.homePath ||
        process.env.CODEX_HOME ||
        path.join(OS.homedir(), ".codex"),
    ),
  );
  const configPath = path.join(codexHome, "config.toml");

  const content = yield* fileSystem
    .readFileString(configPath)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (content === undefined) {
    return undefined;
  }

  let inTopLevel = true;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) {
      inTopLevel = false;
      continue;
    }
    if (!inTopLevel) continue;

    const match = trimmed.match(/^model_provider\s*=\s*["']([^"']+)["']/);
    if (match) return match[1];
  }
  return undefined;
});

/**
 * Returns `true` if `config.toml` specifies a non-OpenAI `model_provider`,
 * meaning the OpenAI login check should be skipped.
 */
export const hasCustomModelProvider = readCodexConfigModelProvider().pipe(
  Effect.map((provider) => provider !== undefined && !OPENAI_AUTH_PROVIDERS.has(provider)),
  Effect.orElseSucceed(() => false),
);
