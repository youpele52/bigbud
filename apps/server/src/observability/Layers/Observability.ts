import { Effect, Layer, Metric, References, Tracer } from "effect";
import { OtlpMetrics, OtlpSerialization, OtlpTracer } from "effect/unstable/observability";

import { ServerConfig } from "../../startup/config.ts";
import { ServerLoggerLive } from "../../startup/serverLogger.ts";
import { makeLocalFileTracer } from "../LocalFileTracer.ts";
import { BrowserTraceCollector } from "../Services/BrowserTraceCollector.ts";
import { makeTraceSink } from "../TraceSink.ts";
import { DEFAULT_TRACE_POLICY, makeTraceRecordRecorder } from "../TracePolicy.ts";
import { traceRecordsDroppedTotal, traceRecordsRetainedTotal } from "../Metrics.load.ts";
import { metricAttributes } from "../Metrics.ts";

const otlpSerializationLayer = OtlpSerialization.layerJson;

export const ObservabilityLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;

    const traceReferencesLayer = Layer.mergeAll(
      Layer.succeed(Tracer.MinimumTraceLevel, config.traceMinLevel),
      Layer.succeed(References.TracerTimingEnabled, config.traceTimingEnabled),
    );

    const tracerLayer = Layer.unwrap(
      Effect.gen(function* () {
        const sink = yield* makeTraceSink({
          filePath: config.serverTracePath,
          maxBytes: config.traceMaxBytes,
          maxFiles: config.traceMaxFiles,
          batchWindowMs: config.traceBatchWindowMs,
        });
        const delegate =
          config.otlpTracesUrl === undefined
            ? undefined
            : yield* OtlpTracer.make({
                url: config.otlpTracesUrl,
                exportInterval: `${config.otlpExportIntervalMs} millis`,
                resource: {
                  serviceName: config.otlpServiceName,
                  attributes: {
                    "service.runtime": "t3-server",
                    "service.mode": config.mode,
                  },
                },
              });

        const tracePolicy = {
          ...DEFAULT_TRACE_POLICY,
          ...(config.traceMode ? { mode: config.traceMode } : {}),
          ...(config.traceMode === "diagnostic" && config.traceDiagnosticTtlMs !== undefined
            ? { expiresAtMs: Date.now() + config.traceDiagnosticTtlMs }
            : {}),
        };
        const services = yield* Effect.services();
        const onTraceDecision = (decision: "retained" | "dropped") => {
          try {
            const metric =
              decision === "retained" ? traceRecordsRetainedTotal : traceRecordsDroppedTotal;
            Metric.withAttributes(
              metric,
              metricAttributes({ source: "local-and-browser" }),
            ).updateUnsafe(1, services);
          } catch {
            // Trace policy metrics must never interfere with trace ingestion.
          }
        };
        const tracer = yield* makeLocalFileTracer({
          filePath: config.serverTracePath,
          maxBytes: config.traceMaxBytes,
          maxFiles: config.traceMaxFiles,
          batchWindowMs: config.traceBatchWindowMs,
          sink,
          ...(delegate ? { delegate } : {}),
          tracePolicy,
          onTraceDecision,
        });
        const recordBrowserTrace = makeTraceRecordRecorder(sink.push, tracePolicy, onTraceDecision);

        return Layer.mergeAll(
          Layer.succeed(Tracer.Tracer, tracer),
          Layer.succeed(BrowserTraceCollector, {
            record: (records) =>
              Effect.sync(() => {
                for (const record of records) {
                  recordBrowserTrace(record);
                }
              }),
          }),
        );
      }),
    ).pipe(Layer.provideMerge(otlpSerializationLayer));

    const metricsLayer =
      config.otlpMetricsUrl === undefined
        ? Layer.empty
        : OtlpMetrics.layer({
            url: config.otlpMetricsUrl,
            exportInterval: `${config.otlpExportIntervalMs} millis`,
            resource: {
              serviceName: config.otlpServiceName,
              attributes: {
                "service.runtime": "t3-server",
                "service.mode": config.mode,
              },
            },
          }).pipe(Layer.provideMerge(otlpSerializationLayer));

    return Layer.mergeAll(ServerLoggerLive, traceReferencesLayer, tracerLayer, metricsLayer);
  }),
);
