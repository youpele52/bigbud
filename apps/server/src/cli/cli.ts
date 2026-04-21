import { NetService } from "@bigbud/shared/Net";
import { parsePersistedServerObservabilitySettings } from "@bigbud/shared/serverSettings";
import { APP_SERVER_NAME, APP_SERVER_SLUG } from "@bigbud/contracts";
import { Config, Effect, FileSystem, LogLevel, Option, Path, Schema } from "effect";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";

import {
  DEFAULT_PORT,
  deriveServerPaths,
  ensureServerDirectories,
  resolveStaticDir,
  ServerConfig,
  RuntimeMode,
  type ServerConfigShape,
} from "../startup/config";
import { readBootstrapEnvelope } from "../startup/bootstrap";
import { expandHomePath, resolveBaseDir } from "../utils/os-jank";
import { runServer } from "../server";

const PortSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));

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
});

const modeFlag = Flag.choice("mode", RuntimeMode.literals).pipe(
  Flag.withDescription("Runtime mode. `desktop` keeps loopback defaults unless overridden."),
  Flag.optional,
);
const portFlag = Flag.integer("port").pipe(
  Flag.withSchema(PortSchema),
  Flag.withDescription("Port for the HTTP/WebSocket server."),
  Flag.optional,
);
const hostFlag = Flag.string("host").pipe(
  Flag.withDescription("Host/interface to bind (for example 127.0.0.1, 0.0.0.0, or a Tailnet IP)."),
  Flag.optional,
);
const baseDirFlag = Flag.string("base-dir").pipe(
  Flag.withDescription("Base directory path (equivalent to T3CODE_HOME)."),
  Flag.optional,
);
const devUrlFlag = Flag.string("dev-url").pipe(
  Flag.withSchema(Schema.URLFromString),
  Flag.withDescription("Dev web URL to proxy/redirect to (equivalent to VITE_DEV_SERVER_URL)."),
  Flag.optional,
);
const noBrowserFlag = Flag.boolean("no-browser").pipe(
  Flag.withDescription("Disable automatic browser opening."),
  Flag.optional,
);
const authTokenFlag = Flag.string("auth-token").pipe(
  Flag.withDescription("Auth token required for WebSocket connections."),
  Flag.withAlias("token"),
  Flag.optional,
);
const bootstrapFdFlag = Flag.integer("bootstrap-fd").pipe(
  Flag.withSchema(Schema.Int),
  Flag.withDescription("Read one-time bootstrap secrets from the given file descriptor."),
  Flag.optional,
);
const autoBootstrapProjectFromCwdFlag = Flag.boolean("auto-bootstrap-project-from-cwd").pipe(
  Flag.withDescription(
    "Create a project for the current working directory on startup when missing.",
  ),
  Flag.optional,
);
const logWebSocketEventsFlag = Flag.boolean("log-websocket-events").pipe(
  Flag.withDescription(
    "Emit server-side logs for outbound WebSocket push traffic (equivalent to BIGBUD_LOG_WS_EVENTS).",
  ),
  Flag.withAlias("log-ws-events"),
  Flag.optional,
);

const aliasedConfig = <A>(primary: Config.Config<A>, legacy: Config.Config<A>) =>
  Config.all({
    primary: primary.pipe(Config.option),
    legacy: legacy.pipe(Config.option),
  }).pipe(Config.map(({ primary, legacy }) => Option.firstSomeOf([primary, legacy])));

const aliasedWithDefault = <A>(
  primary: Config.Config<A>,
  legacy: Config.Config<A>,
  defaultValue: A,
) =>
  aliasedConfig(primary, legacy).pipe(
    Config.map((value) => Option.getOrElse(value, () => defaultValue)),
  );

const aliasedOptional = <A>(primary: Config.Config<A>, legacy: Config.Config<A>) =>
  aliasedConfig(primary, legacy).pipe(Config.map(Option.getOrUndefined));

const EnvServerConfig = Config.all({
  logLevel: aliasedWithDefault(
    Config.logLevel("BIGBUD_LOG_LEVEL"),
    Config.logLevel("T3CODE_LOG_LEVEL"),
    "Info",
  ),
  traceMinLevel: aliasedWithDefault(
    Config.logLevel("BIGBUD_TRACE_MIN_LEVEL"),
    Config.logLevel("T3CODE_TRACE_MIN_LEVEL"),
    "Info",
  ),
  traceTimingEnabled: aliasedWithDefault(
    Config.boolean("BIGBUD_TRACE_TIMING_ENABLED"),
    Config.boolean("T3CODE_TRACE_TIMING_ENABLED"),
    true,
  ),
  traceFile: aliasedOptional(
    Config.string("BIGBUD_TRACE_FILE"),
    Config.string("T3CODE_TRACE_FILE"),
  ),
  traceMaxBytes: aliasedWithDefault(
    Config.int("BIGBUD_TRACE_MAX_BYTES"),
    Config.int("T3CODE_TRACE_MAX_BYTES"),
    10 * 1024 * 1024,
  ),
  traceMaxFiles: aliasedWithDefault(
    Config.int("BIGBUD_TRACE_MAX_FILES"),
    Config.int("T3CODE_TRACE_MAX_FILES"),
    10,
  ),
  traceBatchWindowMs: aliasedWithDefault(
    Config.int("BIGBUD_TRACE_BATCH_WINDOW_MS"),
    Config.int("T3CODE_TRACE_BATCH_WINDOW_MS"),
    200,
  ),
  otlpTracesUrl: aliasedOptional(
    Config.string("BIGBUD_OTLP_TRACES_URL"),
    Config.string("T3CODE_OTLP_TRACES_URL"),
  ),
  otlpMetricsUrl: aliasedOptional(
    Config.string("BIGBUD_OTLP_METRICS_URL"),
    Config.string("T3CODE_OTLP_METRICS_URL"),
  ),
  otlpExportIntervalMs: aliasedWithDefault(
    Config.int("BIGBUD_OTLP_EXPORT_INTERVAL_MS"),
    Config.int("T3CODE_OTLP_EXPORT_INTERVAL_MS"),
    10_000,
  ),
  otlpServiceName: aliasedWithDefault(
    Config.string("BIGBUD_OTLP_SERVICE_NAME"),
    Config.string("T3CODE_OTLP_SERVICE_NAME"),
    APP_SERVER_SLUG,
  ),
  mode: aliasedOptional(
    Config.schema(RuntimeMode, "BIGBUD_MODE"),
    Config.schema(RuntimeMode, "T3CODE_MODE"),
  ),
  port: aliasedOptional(Config.port("BIGBUD_PORT"), Config.port("T3CODE_PORT")),
  host: aliasedOptional(Config.string("BIGBUD_HOST"), Config.string("T3CODE_HOST")),
  t3Home: aliasedOptional(Config.string("BIGBUD_HOME"), Config.string("T3CODE_HOME")),
  devUrl: Config.url("VITE_DEV_SERVER_URL").pipe(Config.option, Config.map(Option.getOrUndefined)),
  noBrowser: aliasedOptional(
    Config.boolean("BIGBUD_NO_BROWSER"),
    Config.boolean("T3CODE_NO_BROWSER"),
  ),
  authToken: aliasedOptional(
    Config.string("BIGBUD_AUTH_TOKEN"),
    Config.string("T3CODE_AUTH_TOKEN"),
  ),
  bootstrapFd: aliasedOptional(
    Config.int("BIGBUD_BOOTSTRAP_FD"),
    Config.int("T3CODE_BOOTSTRAP_FD"),
  ),
  autoBootstrapProjectFromCwd: aliasedOptional(
    Config.boolean("BIGBUD_AUTO_BOOTSTRAP_PROJECT_FROM_CWD"),
    Config.boolean("T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD"),
  ),
  logWebSocketEvents: aliasedOptional(
    Config.boolean("BIGBUD_LOG_WS_EVENTS"),
    Config.boolean("T3CODE_LOG_WS_EVENTS"),
  ),
});

interface CliServerFlags {
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

const loadPersistedObservabilitySettings = Effect.fn(function* (settingsPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(settingsPath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
  }

  const raw = yield* fs.readFileString(settingsPath).pipe(Effect.orElseSucceed(() => ""));
  return parsePersistedServerObservabilitySettings(raw);
});

export const resolveServerConfig = (
  flags: CliServerFlags,
  cliLogLevel: Option.Option<LogLevel.LogLevel>,
) =>
  Effect.gen(function* () {
    const { findAvailablePort } = yield* NetService;
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const env = yield* EnvServerConfig;
    const bootstrapFd = Option.getOrUndefined(flags.bootstrapFd) ?? env.bootstrapFd;
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

    const port = yield* Option.match(
      resolveOptionPrecedence(
        flags.port,
        Option.fromUndefinedOr(env.port),
        Option.flatMap(bootstrapEnvelope, (bootstrap) => Option.fromUndefinedOr(bootstrap.port)),
      ),
      {
        onSome: (value) => Effect.succeed(value),
        onNone: () => {
          if (mode === "desktop") {
            return Effect.succeed(DEFAULT_PORT);
          }
          return findAvailablePort(DEFAULT_PORT);
        },
      },
    );
    const devUrl = Option.getOrElse(
      resolveOptionPrecedence(
        flags.devUrl,
        Option.fromUndefinedOr(env.devUrl),
        Option.flatMap(bootstrapEnvelope, (bootstrap) => Option.fromUndefinedOr(bootstrap.devUrl)),
      ),
      () => undefined,
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
    yield* fs.makeDirectory(cwd, { recursive: true });
    const derivedPaths = yield* deriveServerPaths(baseDir, devUrl);
    yield* ensureServerDirectories(derivedPaths);
    const persistedObservabilitySettings = yield* loadPersistedObservabilitySettings(
      derivedPaths.settingsPath,
    );
    const serverTracePath = env.traceFile ?? derivedPaths.serverTracePath;
    yield* fs.makeDirectory(path.dirname(serverTracePath), { recursive: true });
    const noBrowser = resolveBooleanFlag(
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
    const authToken = Option.getOrUndefined(
      resolveOptionPrecedence(
        flags.authToken,
        Option.fromUndefinedOr(env.authToken),
        Option.flatMap(bootstrapEnvelope, (bootstrap) =>
          Option.fromUndefinedOr(bootstrap.authToken),
        ),
      ),
    );
    const autoBootstrapProjectFromCwd = resolveBooleanFlag(
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
    const host = Option.getOrElse(
      resolveOptionPrecedence(
        flags.host,
        Option.fromUndefinedOr(env.host),
        Option.flatMap(bootstrapEnvelope, (bootstrap) => Option.fromUndefinedOr(bootstrap.host)),
      ),
      () => (mode === "desktop" ? "127.0.0.1" : undefined),
    );
    const logLevel = Option.getOrElse(cliLogLevel, () => env.logLevel);

    const config: ServerConfigShape = {
      logLevel,
      traceMinLevel: env.traceMinLevel,
      traceTimingEnabled: env.traceTimingEnabled,
      traceBatchWindowMs: env.traceBatchWindowMs,
      traceMaxBytes: env.traceMaxBytes,
      traceMaxFiles: env.traceMaxFiles,
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
      cwd,
      baseDir,
      ...derivedPaths,
      serverTracePath,
      host,
      staticDir,
      devUrl,
      noBrowser,
      authToken,
      autoBootstrapProjectFromCwd,
      logWebSocketEvents,
    };

    return config;
  });

const commandFlags = {
  mode: modeFlag,
  port: portFlag,
  host: hostFlag,
  baseDir: baseDirFlag,
  cwd: Argument.string("cwd").pipe(
    Argument.withDescription(
      "Working directory for provider sessions (defaults to the current directory).",
    ),
    Argument.optional,
  ),
  devUrl: devUrlFlag,
  noBrowser: noBrowserFlag,
  authToken: authTokenFlag,
  bootstrapFd: bootstrapFdFlag,
  autoBootstrapProjectFromCwd: autoBootstrapProjectFromCwdFlag,
  logWebSocketEvents: logWebSocketEventsFlag,
} as const;

const rootCommand = Command.make("bigbud", commandFlags).pipe(
  Command.withDescription(`Run the ${APP_SERVER_NAME}.`),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveServerConfig(flags, logLevel);
      return yield* runServer.pipe(Effect.provideService(ServerConfig, config));
    }),
  ),
);

export const cli = rootCommand;
