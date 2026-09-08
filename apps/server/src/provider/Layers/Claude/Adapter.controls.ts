import { type ThreadId } from "@bigbud/contracts";
import { Deferred, Effect } from "effect";

import { ProviderAdapterValidationError, type ProviderAdapterError } from "../../Errors.ts";
import {
  claudeModernizationEventsTotal,
  claudeModernizationMetricAttributes,
  increment,
} from "../../../observability/Metrics.ts";
import { validateMcpAction, type ProviderMcpAction } from "../../providerMcp.ts";
import type { ClaudeAdapterShape } from "../../Services/Claude/Adapter.ts";
import type { ClaudeSessionContext } from "./Adapter.types.ts";
import { PROVIDER } from "./Adapter.types.ts";
import { reconcileClaudeInterruptQueue, toRequestError } from "./Adapter.utils.ts";

export function makeClaudeControlOperations(input: {
  readonly requireSession: (
    threadId: ThreadId,
  ) => Effect.Effect<ClaudeSessionContext, ProviderAdapterError>;
}) {
  const interruptTurn: ClaudeAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (threadId, turnId) {
      const context = yield* input.requireSession(threadId);
      const activeTurnId = context.turnState?.turnId;
      if (turnId !== undefined && activeTurnId !== turnId) return;
      const receipt = yield* Effect.tryPromise({
        try: () => context.query.interrupt(),
        catch: (cause) => toRequestError(threadId, "turn/interrupt", cause),
      });
      context.lastInterruptReceipt = receipt;
      yield* increment(
        claudeModernizationEventsTotal,
        claudeModernizationMetricAttributes({
          event: "interrupt",
          provider: "claudeAgent",
          outcome: "success",
          source: "sdk",
        }),
      );
      const reconciled = reconcileClaudeInterruptQueue(context.queuedUserMessageIds, receipt);
      context.queuedUserMessageIds.clear();
      for (const uuid of reconciled.stillQueued) context.queuedUserMessageIds.add(uuid);

      for (const pending of context.pendingApprovals.values()) {
        yield* Deferred.succeed(pending.decision, "cancel");
      }
      context.pendingApprovals.clear();
      for (const [requestId, pending] of context.pendingUserInputs) {
        pending.cancelled = true;
        context.resolvedUserInputs.set(requestId, {});
        yield* Deferred.succeed(pending.answers, {});
      }
      context.pendingUserInputs.clear();
    },
  );

  const mcpAction =
    (action: Exclude<ProviderMcpAction, { type: "refresh" }>) =>
    (threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.gen(function* () {
        const context = yield* input.requireSession(threadId);
        if (!context.mcpControlsEnabled) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: `mcp/${action.type}`,
            issue: "Claude MCP controls are disabled by rollout settings.",
          });
        }
        const validation = validateMcpAction(action, [...context.requiredMcpServerNames]);
        if (!validation.ok) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: `mcp/${action.type}`,
            issue: validation.issue,
          });
        }
        yield* Effect.tryPromise({
          try: async () => {
            if (action.type === "reconnect") {
              await context.query.reconnectMcpServer(action.serverName);
            } else if (action.type === "toggle") {
              await context.query.toggleMcpServer(action.serverName, action.enabled);
            } else {
              await context.query.setMcpServers(action.servers as never);
            }
          },
          catch: (cause) => toRequestError(threadId, `mcp/${action.type}`, cause),
        });
        if (context.refreshMcpStatuses) yield* context.refreshMcpStatuses();
      });

  const mcp: NonNullable<ClaudeAdapterShape["mcp"]> = {
    refresh: Effect.fn("mcpRefresh")(function* (threadId: ThreadId) {
      const context = yield* input.requireSession(threadId);
      if (context.refreshMcpStatuses) yield* context.refreshMcpStatuses();
      return [...context.mcpStatuses];
    }),
    reconnect: (threadId, serverName) => mcpAction({ type: "reconnect", serverName })(threadId),
    toggle: (threadId, serverName, enabled) =>
      mcpAction({ type: "toggle", serverName, enabled })(threadId),
    replace: (threadId, servers) => mcpAction({ type: "replace", servers })(threadId),
  };

  const readThread: ClaudeAdapterShape["readThread"] = Effect.fn("readThread")(
    function* (threadId) {
      const context = yield* input.requireSession(threadId);
      return {
        threadId: context.session.threadId,
        turns: context.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
      };
    },
  );

  const rollbackThread: ClaudeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
    function* (threadId, numTurns) {
      yield* input.requireSession(threadId);
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "rollbackThread",
        issue: `Claude conversation rollback is unsupported until it can rewind both the SDK transcript and workspace state (requested ${numTurns} turn(s)).`,
      });
    },
  );

  return { interruptTurn, mcp, readThread, rollbackThread };
}
