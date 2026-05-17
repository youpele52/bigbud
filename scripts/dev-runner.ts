#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NetService } from "@bigbud/shared/Net";
import { Effect, Layer, Logger, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { ChildProcess } from "effect/unstable/process";

import {
  type DevMode,
  DEV_RUNNER_MODES,
  DevRunnerError,
  MODE_ARGS,
  OffsetConfig,
  createDevRunnerEnv,
  optionalBooleanConfig,
  optionalPortConfig,
  optionalStringConfig,
  optionalUrlConfig,
  resolveModePortOffsets,
  resolveOffset,
} from "./dev-runner.lib.ts";

export {
  DEFAULT_T3_HOME,
  DEV_RUNNER_MODES,
  DevRunnerError,
  MODE_ARGS,
  createDevRunnerEnv,
  findFirstAvailableOffset,
  resolveModePortOffsets,
  resolveOffset,
} from "./dev-runner.lib.ts";

interface DevRunnerCliInput {
  readonly mode: DevMode;
  readonly t3Home: string | undefined;
  readonly authToken: string | undefined;
  readonly noBrowser: boolean | undefined;
  readonly autoBootstrapProjectFromCwd: boolean | undefined;
  readonly logWebSocketEvents: boolean | undefined;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly devUrl: URL | undefined;
  readonly dryRun: boolean;
  readonly turboArgs: ReadonlyArray<string>;
}

const readOptionalBooleanEnv = (name: string): boolean | undefined => {
  const value = process.env[name];
  if (value === undefined) {
    return undefined;
  }
  if (value === "1" || value.toLowerCase() === "true") {
    return true;
  }
  if (value === "0" || value.toLowerCase() === "false") {
    return false;
  }
  return undefined;
};

const resolveOptionalBooleanOverride = (
  explicitValue: boolean | undefined,
  envValue: boolean | undefined,
): boolean | undefined => {
  if (explicitValue === true) {
    return true;
  }

  if (explicitValue === false) {
    return envValue;
  }

  return envValue;
};

export function runDevRunnerWithInput(input: DevRunnerCliInput) {
  return Effect.gen(function* () {
    const { portOffset, devInstance } = yield* OffsetConfig.asEffect().pipe(
      Effect.mapError(
        (cause) =>
          new DevRunnerError({
            message: "Failed to read T3CODE_PORT_OFFSET/T3CODE_DEV_INSTANCE configuration.",
            cause,
          }),
      ),
    );

    const { offset, source } = yield* Effect.try({
      try: () => resolveOffset({ portOffset, devInstance }),
      catch: (cause) =>
        new DevRunnerError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });

    const envOverrides = {
      noBrowser: readOptionalBooleanEnv("T3CODE_NO_BROWSER"),
      autoBootstrapProjectFromCwd: readOptionalBooleanEnv("T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD"),
      logWebSocketEvents: readOptionalBooleanEnv("T3CODE_LOG_WS_EVENTS"),
    };

    const { serverOffset, webOffset } = yield* resolveModePortOffsets({
      mode: input.mode,
      startOffset: offset,
      hasExplicitServerPort: input.port !== undefined,
      hasExplicitDevUrl: input.devUrl !== undefined,
    });

    const env = yield* createDevRunnerEnv({
      mode: input.mode,
      baseEnv: process.env,
      serverOffset,
      webOffset,
      t3Home: input.t3Home,
      authToken: input.authToken,
      noBrowser: resolveOptionalBooleanOverride(input.noBrowser, envOverrides.noBrowser),
      autoBootstrapProjectFromCwd: resolveOptionalBooleanOverride(
        input.autoBootstrapProjectFromCwd,
        envOverrides.autoBootstrapProjectFromCwd,
      ),
      logWebSocketEvents: resolveOptionalBooleanOverride(
        input.logWebSocketEvents,
        envOverrides.logWebSocketEvents,
      ),
      host: input.host,
      port: input.port,
      devUrl: input.devUrl,
    });

    const selectionSuffix =
      serverOffset !== offset || webOffset !== offset
        ? ` selectedOffset(server=${serverOffset},web=${webOffset})`
        : "";

    yield* Effect.logInfo(
      `[dev-runner] mode=${input.mode} source=${source}${selectionSuffix} serverPort=${String(env.T3CODE_PORT)} webPort=${String(env.PORT)} baseDir=${String(env.T3CODE_HOME)}`,
    );

    if (input.dryRun) {
      return;
    }

    const modeArgs = [...MODE_ARGS[input.mode]];
    const child = yield* ChildProcess.make("turbo", [...modeArgs, ...input.turboArgs], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env,
      extendEnv: false,
      // Windows needs shell mode to resolve .cmd shims (e.g. bun.cmd).
      shell: process.platform === "win32",
      // Keep turbo in the same process group so terminal signals (Ctrl+C)
      // reach it directly. Effect defaults to detached: true on non-Windows,
      // which would put turbo in a new group and require manual forwarding.
      detached: false,
      forceKillAfter: "1500 millis",
    });

    const exitCode = yield* child.exitCode;
    if (exitCode !== 0) {
      return yield* new DevRunnerError({
        message: `turbo exited with code ${exitCode}`,
      });
    }
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof DevRunnerError
        ? cause
        : new DevRunnerError({
            message: cause instanceof Error ? cause.message : "dev-runner failed",
            cause,
          }),
    ),
  );
}

const devRunnerCli = Command.make("dev-runner", {
  mode: Argument.choice("mode", DEV_RUNNER_MODES).pipe(
    Argument.withDescription("Development mode to run."),
  ),
  t3Home: Flag.string("home-dir").pipe(
    Flag.withDescription("Base directory for all bigbud data (equivalent to T3CODE_HOME)."),
    Flag.withFallbackConfig(optionalStringConfig("T3CODE_HOME")),
  ),
  authToken: Flag.string("auth-token").pipe(
    Flag.withDescription("Auth token (forwards to T3CODE_AUTH_TOKEN)."),
    Flag.withAlias("token"),
    Flag.withFallbackConfig(optionalStringConfig("T3CODE_AUTH_TOKEN")),
  ),
  noBrowser: Flag.boolean("no-browser").pipe(
    Flag.withDescription("Browser auto-open toggle (equivalent to T3CODE_NO_BROWSER)."),
    Flag.withFallbackConfig(optionalBooleanConfig("T3CODE_NO_BROWSER")),
  ),
  autoBootstrapProjectFromCwd: Flag.boolean("auto-bootstrap-project-from-cwd").pipe(
    Flag.withDescription(
      "Auto-bootstrap toggle (equivalent to T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD).",
    ),
    Flag.withFallbackConfig(optionalBooleanConfig("T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD")),
  ),
  logWebSocketEvents: Flag.boolean("log-websocket-events").pipe(
    Flag.withDescription("WebSocket event logging toggle (equivalent to T3CODE_LOG_WS_EVENTS)."),
    Flag.withAlias("log-ws-events"),
    Flag.withFallbackConfig(optionalBooleanConfig("T3CODE_LOG_WS_EVENTS")),
  ),
  host: Flag.string("host").pipe(
    Flag.withDescription("Server host/interface override (forwards to T3CODE_HOST)."),
    Flag.withFallbackConfig(optionalStringConfig("T3CODE_HOST")),
  ),
  port: Flag.integer("port").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
    Flag.withDescription("Server port override (forwards to T3CODE_PORT)."),
    Flag.withFallbackConfig(optionalPortConfig("T3CODE_PORT")),
  ),
  devUrl: Flag.string("dev-url").pipe(
    Flag.withSchema(Schema.URLFromString),
    Flag.withDescription("Web dev URL override (forwards to VITE_DEV_SERVER_URL)."),
    Flag.withFallbackConfig(optionalUrlConfig("VITE_DEV_SERVER_URL")),
  ),
  dryRun: Flag.boolean("dry-run").pipe(
    Flag.withDescription("Resolve mode/ports/env and print, but do not spawn turbo."),
    Flag.withDefault(false),
  ),
  turboArgs: Argument.string("turbo-arg").pipe(
    Argument.withDescription("Additional turbo args (pass after `--`)."),
    Argument.variadic(),
  ),
}).pipe(
  Command.withDescription("Run monorepo development modes with deterministic port/env wiring."),
  Command.withHandler((input) => runDevRunnerWithInput(input)),
);

const cliRuntimeLayer = Layer.mergeAll(
  Logger.layer([Logger.consolePretty()]),
  NodeServices.layer,
  NetService.layer,
);

const runtimeProgram = Command.run(devRunnerCli, { version: "0.0.0" }).pipe(
  Effect.scoped,
  Effect.provide(cliRuntimeLayer),
);

if (import.meta.main) {
  NodeRuntime.runMain(runtimeProgram);
}
