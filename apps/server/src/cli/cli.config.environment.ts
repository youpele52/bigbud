import { APP_SERVER_SLUG } from "@bigbud/contracts";
import { Config, Option } from "effect";

import { RuntimeMode } from "../startup/config.ts";
import { TraceModeSchema } from "../observability/TracePolicy.ts";

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

export const EnvServerConfig = Config.all({
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
  // Defaults depend on the runtime mode; see startup/config.traceRotation.ts.
  traceMaxBytes: aliasedOptional(
    Config.int("BIGBUD_TRACE_MAX_BYTES"),
    Config.int("T3CODE_TRACE_MAX_BYTES"),
  ),
  traceMaxFiles: aliasedOptional(
    Config.int("BIGBUD_TRACE_MAX_FILES"),
    Config.int("T3CODE_TRACE_MAX_FILES"),
  ),
  traceBatchWindowMs: aliasedWithDefault(
    Config.int("BIGBUD_TRACE_BATCH_WINDOW_MS"),
    Config.int("T3CODE_TRACE_BATCH_WINDOW_MS"),
    200,
  ),
  traceMode: aliasedOptional(
    Config.schema(TraceModeSchema, "BIGBUD_TRACE_MODE"),
    Config.schema(TraceModeSchema, "T3CODE_TRACE_MODE"),
  ),
  traceDiagnosticTtlMs: aliasedWithDefault(
    Config.int("BIGBUD_TRACE_DIAGNOSTIC_TTL_MS"),
    Config.int("T3CODE_TRACE_DIAGNOSTIC_TTL_MS"),
    15 * 60 * 1000,
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
  remoteMobileEnabled: Config.boolean("BIGBUD_REMOTE_MOBILE_ENABLED").pipe(
    Config.withDefault(false),
  ),
  remoteMobileGatewayCredential: Config.redacted("BIGBUD_MOBILE_GATEWAY_UPSTREAM_CREDENTIAL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
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
