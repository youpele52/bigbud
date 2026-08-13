import { ProviderInterruptTurnInput } from "@bigbud/contracts";
import { Effect, Option } from "effect";

import type { ProviderTurnLivenessRepositoryShape } from "../../persistence/Services/ProviderTurnLiveness.ts";
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
import { markProviderTurnTerminal } from "./ProviderService.turnLiveness.ts";

export function makeInterruptTurn(input: {
  readonly resolveRoutableSession: ResolveRoutableSession;
  readonly analytics: AnalyticsServiceShape;
  readonly liveness: Option.Option<ProviderTurnLivenessRepositoryShape>;
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
      });
      metricProvider = routed.adapter.provider;
      yield* routed.adapter.interruptTurn(routed.threadId, parsed.turnId);
      yield* markProviderTurnTerminal(input.liveness, {
        threadId: parsed.threadId,
        ...(parsed.turnId ? { turnId: parsed.turnId } : {}),
        terminalAt: new Date().toISOString(),
      });
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
