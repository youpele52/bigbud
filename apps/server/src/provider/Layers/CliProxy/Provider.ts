import { existsSync } from "node:fs";
import path from "node:path";

import type { ServerProviderModel } from "@bigbud/contracts";
import { Effect, Layer, Stream } from "effect";

import { buildServerProvider } from "../../providerSnapshot.ts";
import { ProviderAdapterValidationError } from "../../Errors.ts";
import { CliProxyProvider } from "../../Services/CliProxy/Provider.ts";
import { preflightCliProxy, type CliProxyModel } from "./Client.ts";
import { readCliProxyConfig } from "./config.ts";

const PROVIDER = "cliProxy" as const;
const CAPABILITIES = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
} as const;

function binaryAvailable(binary: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PATH ?? "")
    .split(path.delimiter)
    .some((directory) => existsSync(path.join(directory, binary)));
}

export function modelsFromCliProxyPreflight(
  models: ReadonlyArray<CliProxyModel>,
): ReadonlyArray<ServerProviderModel> {
  return models.map((model) => ({
    slug: model.id,
    name: model.displayName ?? model.id,
    isCustom: false,
    group: model.source === "codex" ? "Codex" : "Claude",
    subProviderID: model.source,
    capabilities: CAPABILITIES,
  }));
}

export const checkCliProxyProvider = Effect.fn("checkCliProxyProvider")(function* () {
  const checkedAt = new Date().toISOString();
  const config = readCliProxyConfig();
  if (!config) {
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
        message: "CLIProxy is disabled or incomplete.",
      },
    });
  }
  if (!binaryAvailable("claude")) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "CLIProxy requires Claude Code to be installed on PATH.",
      },
    });
  }
  const response = yield* Effect.tryPromise({
    try: () => preflightCliProxy(config),
    catch: (cause) =>
      new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "readiness",
        issue: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  }).pipe(Effect.result);
  if (response._tag === "Failure") {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `CLIProxy readiness check failed: ${response.failure.message}`,
      },
    });
  }
  const preflight = response.success;
  const ready = preflight.health && preflight.models.length > 0;
  return buildServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models: modelsFromCliProxyPreflight(preflight.models),
    probe: {
      installed: true,
      version: null,
      status: ready ? "ready" : "warning",
      auth: {
        status: ready ? "authenticated" : "unknown",
        type: "environment",
        label: ready
          ? "CLIProxy authenticated model catalog is healthy."
          : "CLIProxy did not return models from an authenticated source.",
      },
    },
  });
});

export const CliProxyProviderLive = Layer.succeed(CliProxyProvider, {
  getSnapshot: checkCliProxyProvider(),
  refresh: checkCliProxyProvider(),
  streamChanges: Stream.empty,
});
