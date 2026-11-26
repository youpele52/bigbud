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
  devModeRequiresWorkspaceAgent,
  optionalBooleanConfig,
  optionalPortConfig,
  optionalStringConfig,
  optionalUrlConfig,
  resolveOffset,
} from "./dev-runner.lib.ts";
import { reserveRunnerPorts } from "./dev-runner.coordination.ts";
import {
  COMPUTER_USE_GUARD_BUILD_ARGS,
  devModeRequiresComputerUseGuard,
} from "./dev-runner.computerUse.ts";
import { prepareDevSshOwnerEnv, withoutDevSshOwnerEnv } from "./dev-runner.sshOwner.ts";

export {
  DEFAULT_BIGBUD_HOME,
  DEFAULT_T3_HOME,
  DEV_RUNNER_MODES,
  DevRunnerError,
  MODE_ARGS,
  createDevRunnerEnv,
  devModeRequiresWorkspaceAgent,
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

const readOptionalBooleanEnv = (primary: string): boolean | undefined => {
  const value = process.env[primary];
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
            message: "Failed to read BIGBUD_PORT_OFFSET/BIGBUD_DEV_INSTANCE configuration.",
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
      noBrowser: readOptionalBooleanEnv("BIGBUD_NO_BROWSER"),
      autoBootstrapProjectFromCwd: readOptionalBooleanEnv("BIGBUD_AUTO_BOOTSTRAP_PROJECT_FROM_CWD"),
      logWebSocketEvents: readOptionalBooleanEnv("BIGBUD_LOG_WS_EVENTS"),
    };

    const cargoBuild = Effect.fn("cargoBuild")(function* (
      args: ReadonlyArray<string>,
      label: { readonly building: string; readonly failed: string },
    ) {
      yield* Effect.logInfo(`[dev-runner] Building the local ${label.building}...`);
      const build = yield* ChildProcess.make("cargo", [...args], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        detached: false,
        forceKillAfter: "1500 millis",
      });
      const exitCode = yield* build.exitCode;
      if (exitCode !== 0) {
        return yield* new DevRunnerError({
          message: `${label.failed} build exited with code ${exitCode}`,
        });
      }
    });

    if (!input.dryRun && devModeRequiresWorkspaceAgent(input.mode)) {
      yield* cargoBuild(["build", "--locked", "--package", "bigbud-remote-agent"], {
        building: "workspace watcher agent",
        failed: "workspace agent",
      });
    }
    // Closed while Driver 0.9.1 is pinned; see dev-runner.computerUse.ts.
    if (!input.dryRun && devModeRequiresComputerUseGuard(input.mode, process.env)) {
      yield* cargoBuild(COMPUTER_USE_GUARD_BUILD_ARGS, {
        building: "computer-use guard",
        failed: "computer-use guard",
      });
    }

    const { serverOffset, webOffset, repoRoot, webReservation } = yield* reserveRunnerPorts({
      mode: input.mode,
      startOffset: offset,
      hasExplicitServerPort: input.port !== undefined,
      hasExplicitDevUrl: input.devUrl !== undefined,
      dryRun: input.dryRun,
    });

    // SSH runs only through the Rust owner: every mode that starts the server builds the
    // owner with Cargo and passes its absolute path as BIGBUD_SSH_OWNER_BIN.
    const baseEnv =
      !input.dryRun && devModeRequiresWorkspaceAgent(input.mode)
        ? yield* prepareDevSshOwnerEnv(process.env)
        : withoutDevSshOwnerEnv(process.env);
    const env = yield* createDevRunnerEnv({
      mode: input.mode,
      baseEnv,
      serverOffset,
      webOffset,
      instanceOffset: offset,
      repoRoot,
      ...(webReservation === undefined ? {} : { webReservation }),
      runnerPid: process.pid,
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
      `[dev-runner] mode=${input.mode} source=${source}${selectionSuffix} serverPort=${String(env.BIGBUD_PORT)} webPort=${String(env.PORT)} mobileStartPort=${String(env.MOBILE_WEB_PORT)} baseDir=${String(env.BIGBUD_HOME)}`,
    );

    if (input.dryRun) return;

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
    Flag.withDescription("Base directory for all bigbud data (equivalent to BIGBUD_HOME)."),
    Flag.withFallbackConfig(optionalStringConfig("BIGBUD_HOME")),
  ),
  authToken: Flag.string("auth-token").pipe(
    Flag.withDescription("Auth token (forwards to BIGBUD_AUTH_TOKEN)."),
    Flag.withAlias("token"),
    Flag.withFallbackConfig(optionalStringConfig("BIGBUD_AUTH_TOKEN")),
  ),
  noBrowser: Flag.boolean("no-browser").pipe(
    Flag.withDescription("Browser auto-open toggle (equivalent to BIGBUD_NO_BROWSER)."),
    Flag.withFallbackConfig(optionalBooleanConfig("BIGBUD_NO_BROWSER")),
  ),
  autoBootstrapProjectFromCwd: Flag.boolean("auto-bootstrap-project-from-cwd").pipe(
    Flag.withDescription(
      "Auto-bootstrap toggle (equivalent to BIGBUD_AUTO_BOOTSTRAP_PROJECT_FROM_CWD).",
    ),
    Flag.withFallbackConfig(optionalBooleanConfig("BIGBUD_AUTO_BOOTSTRAP_PROJECT_FROM_CWD")),
  ),
  logWebSocketEvents: Flag.boolean("log-websocket-events").pipe(
    Flag.withDescription("WebSocket event logging toggle (equivalent to BIGBUD_LOG_WS_EVENTS)."),
    Flag.withAlias("log-ws-events"),
    Flag.withFallbackConfig(optionalBooleanConfig("BIGBUD_LOG_WS_EVENTS")),
  ),
  host: Flag.string("host").pipe(
    Flag.withDescription("Server host/interface override (forwards to BIGBUD_HOST)."),
    Flag.withFallbackConfig(optionalStringConfig("BIGBUD_HOST")),
  ),
  port: Flag.integer("port").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
    Flag.withDescription("Server port override (forwards to BIGBUD_PORT)."),
    Flag.withFallbackConfig(optionalPortConfig("BIGBUD_PORT")),
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
