import { ProviderInterruptTurnInput } from "@bigbud/contracts";
import { Effect } from "effect";

import {
  providerMetricAttributes,
  providerTurnsTotal,
  withMetrics,
} from "../../observability/Metrics.ts";
import type { AnalyticsServiceShape } from "../../telemetry/Services/AnalyticsService.ts";
import type { ProviderServiceError } from "../Errors.ts";
import type { ProviderServiceShape } from "../Services/ProviderService.ts";
import { decodeInputOrValidationError } from "./ProviderServiceHelpers.ts";
import type { ResolveRoutableSession } from "./ProviderService.operations.ts";

export function makeInterruptTurn(input: {
  readonly resolveRoutableSession: ResolveRoutableSession;
  readonly analytics: AnalyticsServiceShape;
}): ProviderServiceShape["interruptTurn"] {
  return Effect.fn("interruptTurn")(function* (rawInput) {
    const parsed = yield* decodeInputOrValidationError({
      operation: "ProviderService.interruptTurn",
      schema: ProviderInterruptTurnInput,
      payload: rawInput,
    });
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* input.resolveRoutableSession({
        threadId: parsed.threadId,
        operation: "ProviderService.interruptTurn",
        allowRecovery: true,
        ...(parsed.sessionEpoch !== undefined ? { expectedSessionEpoch: parsed.sessionEpoch } : {}),
      });
      metricProvider = routed.adapter.provider;
      yield* routed.adapter.interruptTurn(routed.threadId, parsed.turnId);
      yield* input.analytics.record("provider.turn.interrupted", {
        provider: routed.adapter.provider,
      });
    }).pipe(
      Effect.mapError((error) => error as ProviderServiceError),
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, { operation: "interrupt" }),
      }),
    );
  });
}
