import type { OrchestrationEvent } from "@bigbud/contracts";
import { Cause, Duration, Effect, Exit, Metric } from "effect";
import {
  metricAttributes,
  orchestrationCommandDuration,
  orchestrationCommandsTotal,
} from "../../observability/Metrics.ts";
import {
  orchestrationEventPayloadBytes,
  orchestrationEventsAppendedTotal,
} from "../../observability/Metrics.load.ts";
const encoder = new TextEncoder();
export const recordAppendedEventMetrics = Effect.fn(
  "OrchestrationEngine.recordAppendedEventMetrics",
)(function* (event: OrchestrationEvent) {
  const attributes = metricAttributes({ eventType: event.type });
  yield* Metric.update(Metric.withAttributes(orchestrationEventsAppendedTotal, attributes), 1);
  yield* Metric.update(
    Metric.withAttributes(orchestrationEventPayloadBytes, attributes),
    encoder.encode(JSON.stringify(event.payload)).byteLength,
  );
});

export const recordCommandResultMetrics = Effect.fn(
  "OrchestrationEngine.recordCommandResultMetrics",
)(function* (
  exit: Exit.Exit<unknown, unknown>,
  attributes: { commandType: string; aggregateKind: string },
  startedAt: number,
) {
  const outcome = Exit.isSuccess(exit)
    ? "success"
    : Cause.hasInterruptsOnly(exit.cause)
      ? "interrupt"
      : "failure";
  yield* Metric.update(
    Metric.withAttributes(orchestrationCommandDuration, metricAttributes(attributes)),
    Duration.millis(Math.max(0, Date.now() - startedAt)),
  );
  yield* Metric.update(
    Metric.withAttributes(orchestrationCommandsTotal, metricAttributes({ ...attributes, outcome })),
    1,
  );
});
