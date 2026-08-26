import { Metric } from "effect";

export const orchestrationEventsAppendedTotal = Metric.counter(
  "bigbud_orchestration_events_appended_total",
  { description: "Canonical orchestration events appended by event type." },
);

export const orchestrationEventPayloadBytes = Metric.histogram(
  "bigbud_orchestration_event_payload_bytes",
  {
    description: "Canonical orchestration event payload size in bytes.",
    boundaries: [256, 1_024, 4_096, 16_384, 65_536, 262_144],
  },
);

export const traceRecordsRetainedTotal = Metric.counter("bigbud_trace_records_retained_total", {
  description: "Trace records retained by the local trace policy.",
});

export const traceRecordsDroppedTotal = Metric.counter("bigbud_trace_records_dropped_total", {
  description: "Trace records dropped by the local trace policy.",
});

export const providerReconciliationDiscoveryTotal = Metric.counter(
  "t3_provider_reconciliation_discovery_total",
  { description: "Provider reconciliation discovery calls and cache outcomes." },
);

export const providerReconciliationPassesTotal = Metric.counter(
  "t3_provider_reconciliation_passes_total",
  { description: "Provider reconciliation pass outcomes." },
);
