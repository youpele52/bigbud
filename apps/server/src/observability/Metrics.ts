import { Duration, Effect, Exit, Metric } from "effect";
import { dual } from "effect/Function";
import type { ProviderRuntimeEvent } from "@bigbud/contracts";

import {
  compactMetricAttributes,
  normalizeModelMetricLabel,
  outcomeFromExit,
} from "./Attributes.ts";

export const rpcRequestsTotal = Metric.counter("t3_rpc_requests_total", {
  description: "Total RPC requests handled by the websocket RPC server.",
});

export const rpcRequestDuration = Metric.timer("t3_rpc_request_duration", {
  description: "RPC request handling duration.",
});

export const orchestrationCommandsTotal = Metric.counter("t3_orchestration_commands_total", {
  description: "Total orchestration commands dispatched.",
});

export const orchestrationCommandDuration = Metric.timer("t3_orchestration_command_duration", {
  description: "Orchestration command dispatch duration.",
});

export const orchestrationCommandAckDuration = Metric.timer(
  "t3_orchestration_command_ack_duration",
  {
    description:
      "Time from orchestration command dispatch to the first committed domain event emitted for that command.",
  },
);

export const orchestrationEventsProcessedTotal = Metric.counter(
  "t3_orchestration_events_processed_total",
  {
    description: "Total orchestration intent events processed by runtime reactors.",
  },
);

export const providerSessionsTotal = Metric.counter("t3_provider_sessions_total", {
  description: "Total provider session lifecycle operations.",
});

export const providerTurnsTotal = Metric.counter("t3_provider_turns_total", {
  description: "Total provider turn lifecycle operations.",
});

export const providerTurnDuration = Metric.timer("t3_provider_turn_duration", {
  description: "Provider turn request duration.",
});

export const providerRuntimeEventsTotal = Metric.counter("t3_provider_runtime_events_total", {
  description: "Total canonical provider runtime events processed.",
});

export const gitCommandsTotal = Metric.counter("t3_git_commands_total", {
  description: "Total git commands executed by the server runtime.",
});

export const gitCommandDuration = Metric.timer("t3_git_command_duration", {
  description: "Git command execution duration.",
});

export const terminalSessionsTotal = Metric.counter("t3_terminal_sessions_total", {
  description: "Total terminal sessions started.",
});

export const terminalRestartsTotal = Metric.counter("t3_terminal_restarts_total", {
  description: "Total terminal restart requests handled.",
});

/** Low-cardinality counters for the Claude modernization rollout. */
export const claudeModernizationEventsTotal = Metric.counter(
  "t3_claude_modernization_events_total",
  { description: "Privacy-safe Claude modernization lifecycle events." },
);

const CLAUDE_MODERNIZATION_EVENT_NAMES = new Set([
  "initialization",
  "unknown_message",
  "task_reconciliation",
  "activity_suppression",
  "approval_replay",
  "approval_conflict",
  "interrupt",
  "reinitialize",
  "mcp",
]);

const CLAUDE_METRIC_PROVIDERS = new Set(["claudeAgent"]);
const CLAUDE_METRIC_OUTCOMES = new Set([
  "success",
  "failure",
  "cancelled",
  "conflict",
  "suppressed",
  "unavailable",
]);
const CLAUDE_METRIC_SOURCES = new Set(["sdk", "runtime", "recovery", "initialization"]);
const CLAUDE_METRIC_MODES = new Set([
  "accept",
  "deny",
  "cancel",
  "session",
  "required",
  "optional",
]);

const allowlistedClaudeMetricDimension = (
  value: string | undefined,
  allowed: ReadonlySet<string>,
): string | undefined => (value && allowed.has(value) ? value : undefined);

/** Allowlist rollout dimensions; prompts, paths, URLs, tokens, and SDK payloads are excluded. */
export function claudeModernizationMetricAttributes(input: {
  readonly event: string;
  readonly provider?: string;
  readonly outcome?: string;
  readonly source?: string;
  readonly mode?: string;
}): Readonly<Record<string, string>> {
  return compactMetricAttributes({
    event: CLAUDE_MODERNIZATION_EVENT_NAMES.has(input.event) ? input.event : "unknown",
    provider: allowlistedClaudeMetricDimension(input.provider, CLAUDE_METRIC_PROVIDERS),
    outcome: allowlistedClaudeMetricDimension(input.outcome, CLAUDE_METRIC_OUTCOMES),
    source: allowlistedClaudeMetricDimension(input.source, CLAUDE_METRIC_SOURCES),
    mode: allowlistedClaudeMetricDimension(input.mode, CLAUDE_METRIC_MODES),
  });
}

export function claudeRuntimeMetricAttributes(
  event: ProviderRuntimeEvent,
): Readonly<Record<string, string>> | undefined {
  if (event.provider !== "claudeAgent") return undefined;
  const name =
    event.type === "session.configured"
      ? "initialization"
      : event.type === "task.updated" || event.type === "turn.plan.updated"
        ? "task_reconciliation"
        : event.type === "mcp.status.updated" || event.type === "mcp.oauth.completed"
          ? "mcp"
          : event.type === "runtime.warning"
            ? "unknown_message"
            : event.type === "turn.completed" && event.payload.state === "interrupted"
              ? "interrupt"
              : undefined;
  return name
    ? claudeModernizationMetricAttributes({
        event: name,
        provider: "claudeAgent",
        source: "runtime",
      })
    : undefined;
}

export const metricAttributes = (
  attributes: Readonly<Record<string, unknown>>,
): ReadonlyArray<[string, string]> => Object.entries(compactMetricAttributes(attributes));

export const increment = (
  metric: Metric.Metric<number, unknown>,
  attributes: Readonly<Record<string, unknown>>,
  amount = 1,
) => Metric.update(Metric.withAttributes(metric, metricAttributes(attributes)), amount);

export interface WithMetricsOptions {
  readonly counter?: Metric.Metric<number, unknown>;
  readonly timer?: Metric.Metric<Duration.Duration, unknown>;
  readonly attributes?:
    | Readonly<Record<string, unknown>>
    | (() => Readonly<Record<string, unknown>>);
  readonly outcomeAttributes?: (
    outcome: ReturnType<typeof outcomeFromExit>,
  ) => Readonly<Record<string, unknown>>;
}

const withMetricsImpl = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: WithMetricsOptions,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const startedAt = Date.now();
    const exit = yield* Effect.exit(effect);
    const duration = Duration.millis(Math.max(0, Date.now() - startedAt));
    const baseAttributes =
      typeof options.attributes === "function" ? options.attributes() : (options.attributes ?? {});

    if (options.timer) {
      yield* Metric.update(
        Metric.withAttributes(options.timer, metricAttributes(baseAttributes)),
        duration,
      );
    }

    if (options.counter) {
      const outcome = outcomeFromExit(exit);
      yield* Metric.update(
        Metric.withAttributes(
          options.counter,
          metricAttributes({
            ...baseAttributes,
            outcome,
            ...(options.outcomeAttributes ? options.outcomeAttributes(outcome) : {}),
          }),
        ),
        1,
      );
    }

    if (Exit.isSuccess(exit)) {
      return exit.value;
    }
    return yield* Effect.failCause(exit.cause);
  });

export const withMetrics: {
  <A, E, R>(
    options: WithMetricsOptions,
  ): (effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  <A, E, R>(effect: Effect.Effect<A, E, R>, options: WithMetricsOptions): Effect.Effect<A, E, R>;
} = dual(2, withMetricsImpl);

export const providerMetricAttributes = (
  provider: string,
  extra?: Readonly<Record<string, unknown>>,
) =>
  compactMetricAttributes({
    provider,
    ...extra,
  });

export const providerTurnMetricAttributes = (input: {
  readonly provider: string;
  readonly model: string | null | undefined;
  readonly extra?: Readonly<Record<string, unknown>>;
}) => {
  const modelFamily = normalizeModelMetricLabel(input.model);
  return compactMetricAttributes({
    provider: input.provider,
    ...(modelFamily ? { modelFamily } : {}),
    ...input.extra,
  });
};
