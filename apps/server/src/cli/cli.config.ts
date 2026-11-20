import { RemoteBackendAuthorityError } from "../remote-backend/authority.record.ts";
import { EnvServerConfig } from "./cli.config.environment.ts";
import { desktopLifecycleFields } from "./cli.config.desktop.ts";
import { loadPersistedObservabilitySettings } from "./cli.config.observability.ts";
import {
  assertRemoteStartupOptions,
  remoteClientSocketPath,
  RemoteProfileConfigurationError,
} from "../startup/config.remote.ts";
import { resolveRemoteMobileConfiguration } from "../startup/config.remoteMobile.ts";
import { resolveTraceRotation } from "../startup/config.traceRotation.ts";
import { ensurePrivateRemoteStateRoot } from "../remote-backend/authority.files.ts";

import { NetService } from "@bigbud/shared/Net";
import {
  DesktopBackendStartReason,
  DesktopLifecycleHintFd,
} from "@bigbud/contracts/server/desktopLifecycleHint.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as LogLevel from "effect/LogLevel";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import {
  DEFAULT_PORT,
  deriveServerPaths,
  ensureServerDirectories,
  resolveStaticDir,
  resolveMobileWebStaticDir,
  RuntimeMode,
  type ServerConfigShape,
} from "../startup/config";
import { captureTerminalShellInstallEvidence } from "../startup/config.terminalShells.ts";
import { readBootstrapEnvelope } from "../startup/bootstrap";
import { expandHomePath, resolveBaseDir } from "../utils/os-jank";
import { setSystemMonitorAgentAccess } from "../orchestration-tools/ThreadSystemResourcesTool.client.ts";

export const PortSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));

const BootstrapEnvelopeSchema = Schema.Struct({
  mode: Schema.optional(RuntimeMode),
  port: Schema.optional(PortSchema),
  host: Schema.optional(Schema.String),
  t3Home: Schema.optional(Schema.String),
  devUrl: Schema.optional(Schema.URLFromString),
  noBrowser: Schema.optional(Schema.Boolean),
  authToken: Schema.optional(Schema.String),
  autoBootstrapProjectFromCwd: Schema.optional(Schema.Boolean),
  logWebSocketEvents: Schema.optional(Schema.Boolean),
  otlpTracesUrl: Schema.optional(Schema.String),
  otlpMetricsUrl: Schema.optional(Schema.String),
  systemMonitorAgentAccess: Schema.optional(
    Schema.Struct({
      endpoint: Schema.String,
      token: Schema.String,
    }),
  ),
  startReason: Schema.optional(DesktopBackendStartReason),
  lifecycleHintFd: Schema.optional(DesktopLifecycleHintFd),
  ownershipHandoff: Schema.optional(Schema.Boolean),
});

export interface CliServerFlags {
  readonly mode: Option.Option<RuntimeMode>;
  readonly port: Option.Option<number>;
  readonly host: Option.Option<string>;
  readonly baseDir: Option.Option<string>;
  readonly cwd: Option.Option<string>;
  readonly devUrl: Option.Option<URL>;
  readonly noBrowser: Option.Option<boolean>;
  readonly authToken: Option.Option<string>;
  readonly bootstrapFd: Option.Option<number>;
  readonly autoBootstrapProjectFromCwd: Option.Option<boolean>;
  readonly logWebSocketEvents: Option.Option<boolean>;
}

const resolveBooleanFlag = (flag: Option.Option<boolean>, envValue: boolean) =>
  Option.getOrElse(Option.filter(flag, Boolean), () => envValue);

const resolveOptionPrecedence = <Value>(
  ...values: ReadonlyArray<Option.Option<Value>>
): Option.Option<Value> => Option.firstSomeOf(values);

export const resolveServerConfig = (
  flags: CliServerFlags,
  cliLogLevel: Option.Option<LogLevel.LogLevel>,
  platform: NodeJS.Platform = process.platform,
) =>
  Effect.gen(function* () {
    const { findAvailablePort } = yield* NetService;
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const env = yield* EnvServerConfig;
    const bootstrapFd = Option.getOrUndefined(flags.bootstrapFd) ?? env.bootstrapFd;
    const knownMode = Option.getOrUndefined(flags.mode) ?? env.mode;
    if (env.remoteMobileEnabled && knownMode !== "remote")
      return yield* Effect.fail(
        new RemoteProfileConfigurationError(
          "The remote mobile extension requires explicit remote backend mode before desktop bootstrap.",
        ),
      );
    if (knownMode === "remote" && bootstrapFd !== undefined) {
      return yield* Effect.fail(
        new RemoteProfileConfigurationError(
          "Remote mode cannot use the desktop bootstrap or lifecycle descriptors.",
        ),
      );
    }
    const bootstrapEnvelope =
      bootstrapFd !== undefined
        ? yield* readBootstrapEnvelope(BootstrapEnvelopeSchema, bootstrapFd)
        : Option.none();

    const mode: RuntimeMode = Option.getOrElse(
      resolveOptionPrecedence(
        flags.mode,
        Option.fromUndefinedOr(env.mode),
        Option.flatMap(bootstrapEnvelope, (bootstrap) => Option.fromUndefinedOr(bootstrap.mode)),
      ),
      () => "web",
    );

    const authToken = Option.getOrUndefined(
      resolveOptionPrecedence(
        flags.authToken,
        Option.fromUndefinedOr(env.authToken),
        Option.flatMap(bootstrapEnvelope, (bootstrap) =>
          Option.fromUndefinedOr(bootstrap.authToken),
        ),
      ),
    );
    const devUrl = Option.getOrElse(
      resolveOptionPrecedence(
        flags.devUrl,
        Option.fromUndefinedOr(env.devUrl),
        Option.flatMap(bootstrapEnvelope, (bootstrap) => Option.fromUndefinedOr(bootstrap.devUrl)),
      ),
      () => undefined,
    );
    const host = Option.getOrElse(
      resolveOptionPrecedence(
        flags.host,
        Option.fromUndefinedOr(env.host),
        Option.flatMap(bootstrapEnvelope, (bootstrap) => Option.fromUndefinedOr(bootstrap.host)),
      ),
      () => (mode !== "web" ? "127.0.0.1" : undefined),
    );
    yield* Effect.try({
      try: () =>
        assertRemoteStartupOptions(
          { mode, authToken, devUrl, host, bootstrapRequested: bootstrapFd !== undefined },
          platform,
        ),
      catch: (cause) =>
        cause instanceof RemoteProfileConfigurationError
          ? cause
          : new RemoteProfileConfigurationError("Remote startup validation failed."),
    });
    const remoteMobile = yield* Effect.try({
      try: () =>
        resolveRemoteMobileConfiguration({
          mode,
          enabled: env.remoteMobileEnabled,
          clientToken: authToken,
          gatewayCredential: env.remoteMobileGatewayCredential
            ? Redacted.value(env.remoteMobileGatewayCredential)
            : undefined,
        }),
      catch: (cause) =>
        cause instanceof RemoteProfileConfigurationError
          ? cause
          : new RemoteProfileConfigurationError("Remote mobile configuration is invalid."),
    });
    if (mode !== "remote")
      setSystemMonitorAgentAccess(
        Option.getOrUndefined(bootstrapEnvelope)?.systemMonitorAgentAccess,
      );
    const port = yield* Option.match(
      resolveOptionPrecedence(
        flags.port,
        Option.fromUndefinedOr(env.port),
        Option.flatMap(bootstrapEnvelope, (bootstrap) => Option.fromUndefinedOr(bootstrap.port)),
      ),
      {
        onSome: (value) => Effect.succeed(value),
        onNone: () =>
          mode === "remote"
            ? Effect.succeed(0)
            : mode === "desktop"
              ? Effect.succeed(DEFAULT_PORT)
              : findAvailablePort(DEFAULT_PORT),
      },
    );
    const baseDir = yield* resolveBaseDir(
      Option.getOrUndefined(
        resolveOptionPrecedence(
          flags.baseDir,
          Option.fromUndefinedOr(env.t3Home),
          Option.flatMap(bootstrapEnvelope, (bootstrap) =>
            Option.fromUndefinedOr(bootstrap.t3Home),
          ),
        ),
      ),
    );
    const rawCwd = Option.getOrElse(flags.cwd, () => process.cwd());
    const cwd = path.resolve(yield* expandHomePath(rawCwd.trim()));
    const derivedPaths = yield* deriveServerPaths(baseDir, devUrl);
    const remoteSocketPath =
      mode === "remote"
        ? yield* Effect.try({
            try: () => remoteClientSocketPath(derivedPaths.stateDir),
            catch: (cause) =>
              cause instanceof RemoteProfileConfigurationError
                ? cause
                : new RemoteProfileConfigurationError("Remote socket configuration failed."),
          })
        : undefined;
    if (mode === "remote")
      yield* Effect.tryPromise({
        try: () => ensurePrivateRemoteStateRoot(derivedPaths.stateDir),
        catch: (cause) =>
          cause instanceof RemoteBackendAuthorityError
            ? cause
            : new RemoteProfileConfigurationError(
                "The remote state root could not be opened privately.",
              ),
      });
    const terminalShellInstallEvidence = yield* captureTerminalShellInstallEvidence(
      derivedPaths.stateDir,
      mode,
    );
    yield* fs.makeDirectory(cwd, { recursive: true });
    yield* ensureServerDirectories(derivedPaths);
    const persistedObservabilitySettings = yield* loadPersistedObservabilitySettings(
      derivedPaths.settingsPath,
    );
    const serverTracePath = env.traceFile ?? derivedPaths.serverTracePath;
    yield* fs.makeDirectory(path.dirname(serverTracePath), { recursive: true });
    const noBrowser =
      mode === "remote" ||
      resolveBooleanFlag(
        flags.noBrowser,
        Option.getOrElse(
          resolveOptionPrecedence(
            Option.fromUndefinedOr(env.noBrowser),
            Option.flatMap(bootstrapEnvelope, (bootstrap) =>
              Option.fromUndefinedOr(bootstrap.noBrowser),
            ),
          ),
          () => mode === "desktop",
        ),
      );
    const autoBootstrapProjectFromCwd =
      mode !== "remote" &&
      resolveBooleanFlag(
        flags.autoBootstrapProjectFromCwd,
        Option.getOrElse(
          resolveOptionPrecedence(
            Option.fromUndefinedOr(env.autoBootstrapProjectFromCwd),
            Option.flatMap(bootstrapEnvelope, (bootstrap) =>
              Option.fromUndefinedOr(bootstrap.autoBootstrapProjectFromCwd),
            ),
          ),
          () => mode === "web",
        ),
      );
    const logWebSocketEvents = resolveBooleanFlag(
      flags.logWebSocketEvents,
      Option.getOrElse(
        resolveOptionPrecedence(
          Option.fromUndefinedOr(env.logWebSocketEvents),
          Option.flatMap(bootstrapEnvelope, (bootstrap) =>
            Option.fromUndefinedOr(bootstrap.logWebSocketEvents),
          ),
        ),
        () => Boolean(devUrl),
      ),
    );
    const staticDir = devUrl ? undefined : yield* resolveStaticDir();
    const mobileWebStaticDir = yield* resolveMobileWebStaticDir();
    const logLevel = Option.getOrElse(cliLogLevel, () => env.logLevel);

    return {
      logLevel,
      traceMinLevel: env.traceMinLevel,
      traceTimingEnabled: env.traceTimingEnabled,
      traceBatchWindowMs: env.traceBatchWindowMs,
      ...resolveTraceRotation(mode, {
        maxBytes: env.traceMaxBytes,
        maxFiles: env.traceMaxFiles,
      }),
      ...(env.traceMode === undefined ? {} : { traceMode: env.traceMode }),
      traceDiagnosticTtlMs: env.traceDiagnosticTtlMs,
      otlpTracesUrl:
        env.otlpTracesUrl ??
        Option.getOrUndefined(
          Option.flatMap(bootstrapEnvelope, (bootstrap) =>
            Option.fromUndefinedOr(bootstrap.otlpTracesUrl),
          ),
        ) ??
        persistedObservabilitySettings.otlpTracesUrl,
      otlpMetricsUrl:
        env.otlpMetricsUrl ??
        Option.getOrUndefined(
          Option.flatMap(bootstrapEnvelope, (bootstrap) =>
            Option.fromUndefinedOr(bootstrap.otlpMetricsUrl),
          ),
        ) ??
        persistedObservabilitySettings.otlpMetricsUrl,
      otlpExportIntervalMs: env.otlpExportIntervalMs,
      otlpServiceName: env.otlpServiceName,
      mode,
      port,
      ...(remoteSocketPath === undefined ? {} : { remoteSocketPath }),
      ...(remoteMobile === undefined ? {} : { remoteMobile }),
      cwd,
      baseDir,
      ...derivedPaths,
      terminalShellInstallEvidence,
      serverTracePath,
      host,
      staticDir,
      mobileWebStaticDir,
      devUrl,
      noBrowser,
      authToken,
      autoBootstrapProjectFromCwd,
      logWebSocketEvents,
      ...desktopLifecycleFields(Option.getOrUndefined(bootstrapEnvelope), mode),
    } satisfies ServerConfigShape;
  });
