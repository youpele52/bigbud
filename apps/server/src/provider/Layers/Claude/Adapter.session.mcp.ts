import type { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import { ProviderAdapterProcessError } from "../../Errors.ts";
import {
  mcpReadinessPolicy,
  normalizeMcpServerStatuses,
  shouldPollRequiredMcpStatuses,
} from "../../providerMcp.ts";
import type { ClaudeQueryRuntime, ClaudeSessionContext } from "./Adapter.types.ts";
import { PROVIDER } from "./Adapter.types.ts";
import { toMessage } from "./Adapter.utils.ts";

const MCP_STARTUP_GRACE_MS = 5_000;
const MCP_STARTUP_INITIAL_DELAY_MS = 100;
const MCP_STARTUP_MAX_DELAY_MS = 1_000;

function describeUnreadyRequiredServers(
  statuses: ClaudeSessionContext["mcpStatuses"],
  requiredServerNames: ReadonlyArray<string>,
): string {
  return requiredServerNames
    .flatMap((name) => {
      const status = statuses.find((entry) => entry.name === name);
      if (status?.status === "connected") return [];
      if (!status) return [`${name} (missing)`];
      return [`${name} (${status.status}${status.message ? `: ${status.message}` : ""})`];
    })
    .join(", ");
}

export const initializeClaudeMcpLifecycle = Effect.fn("initializeClaudeMcpLifecycle")(
  function* (input: {
    readonly context: ClaudeSessionContext;
    readonly query: ClaudeQueryRuntime;
    readonly threadId: ThreadId;
  }) {
    const requiredServerNames = [...input.context.requiredMcpServerNames];
    input.context.refreshMcpStatuses = Effect.fn("refreshMcpStatuses")(function* () {
      let elapsedMs = 0;
      let delayMs = MCP_STARTUP_INITIAL_DELAY_MS;
      while (true) {
        const statuses = yield* Effect.tryPromise({
          try: () => input.query.mcpServerStatus(),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: toMessage(cause, "Failed to refresh Claude MCP server status."),
              cause,
            }),
        });
        input.context.mcpStatuses = normalizeMcpServerStatuses(statuses);
        if (!shouldPollRequiredMcpStatuses(input.context.mcpStatuses, requiredServerNames)) break;
        if (elapsedMs >= MCP_STARTUP_GRACE_MS) {
          break;
        }
        const sleepMs = Math.min(delayMs, MCP_STARTUP_GRACE_MS - elapsedMs);
        yield* Effect.sleep(sleepMs);
        elapsedMs += sleepMs;
        delayMs = Math.min(delayMs * 2, MCP_STARTUP_MAX_DELAY_MS);
      }
    });

    yield* input.context.refreshMcpStatuses();
    if (!mcpReadinessPolicy(input.context.mcpStatuses, requiredServerNames).requiredReady) {
      return yield* new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId: input.threadId,
        detail: `Required Claude MCP bridge is unavailable: ${describeUnreadyRequiredServers(
          input.context.mcpStatuses,
          requiredServerNames,
        )}.`,
      });
    }
  },
);
