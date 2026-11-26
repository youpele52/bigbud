import { APP_SERVER_SLUG } from "@bigbud/contracts";
import { Config, Option } from "effect";

import { RuntimeMode } from "../startup/config.ts";
import { TraceModeSchema } from "../observability/TracePolicy.ts";

const optional = <A>(config: Config.Config<A>) =>
  config.pipe(Config.option, Config.map(Option.getOrUndefined));

export const EnvServerConfig = Config.all({
  logLevel: Config.logLevel("BIGBUD_LOG_LEVEL").pipe(Config.withDefault("Info")),
  traceMinLevel: Config.logLevel("BIGBUD_TRACE_MIN_LEVEL").pipe(Config.withDefault("Info")),
  traceTimingEnabled: Config.boolean("BIGBUD_TRACE_TIMING_ENABLED").pipe(Config.withDefault(true)),
  traceFile: optional(Config.string("BIGBUD_TRACE_FILE")),
  // Defaults depend on the runtime mode; see startup/config.traceRotation.ts.
  traceMaxBytes: optional(Config.int("BIGBUD_TRACE_MAX_BYTES")),
  traceMaxFiles: optional(Config.int("BIGBUD_TRACE_MAX_FILES")),
  traceBatchWindowMs: Config.int("BIGBUD_TRACE_BATCH_WINDOW_MS").pipe(Config.withDefault(200)),
  traceMode: optional(Config.schema(TraceModeSchema, "BIGBUD_TRACE_MODE")),
  traceDiagnosticTtlMs: Config.int("BIGBUD_TRACE_DIAGNOSTIC_TTL_MS").pipe(
    Config.withDefault(15 * 60 * 1000),
  ),
  otlpTracesUrl: optional(Config.string("BIGBUD_OTLP_TRACES_URL")),
  otlpMetricsUrl: optional(Config.string("BIGBUD_OTLP_METRICS_URL")),
  otlpExportIntervalMs: Config.int("BIGBUD_OTLP_EXPORT_INTERVAL_MS").pipe(
    Config.withDefault(10_000),
  ),
  otlpServiceName: Config.string("BIGBUD_OTLP_SERVICE_NAME").pipe(
    Config.withDefault(APP_SERVER_SLUG),
  ),
  mode: optional(Config.schema(RuntimeMode, "BIGBUD_MODE")),
  remoteMobileEnabled: Config.boolean("BIGBUD_REMOTE_MOBILE_ENABLED").pipe(
    Config.withDefault(false),
  ),
  remoteMobileGatewayCredential: Config.redacted("BIGBUD_MOBILE_GATEWAY_UPSTREAM_CREDENTIAL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  port: optional(Config.port("BIGBUD_PORT")),
  host: optional(Config.string("BIGBUD_HOST")),
  t3Home: optional(Config.string("BIGBUD_HOME")),
  devUrl: Config.url("VITE_DEV_SERVER_URL").pipe(Config.option, Config.map(Option.getOrUndefined)),
  noBrowser: optional(Config.boolean("BIGBUD_NO_BROWSER")),
  authToken: optional(Config.string("BIGBUD_AUTH_TOKEN")),
  bootstrapFd: optional(Config.int("BIGBUD_BOOTSTRAP_FD")),
  autoBootstrapProjectFromCwd: optional(Config.boolean("BIGBUD_AUTO_BOOTSTRAP_PROJECT_FROM_CWD")),
  logWebSocketEvents: optional(Config.boolean("BIGBUD_LOG_WS_EVENTS")),
});
