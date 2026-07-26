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

export const initializeClaudeMcpLifecycle = Effect.fn("initializeClaudeMcpLifecycle")(
  function* (input: {
    readonly context: ClaudeSessionContext;
    readonly query: ClaudeQueryRuntime;
    readonly threadId: ThreadId;
  }) {
    const requiredServerNames = [...input.context.requiredMcpServerNames];
    input.context.refreshMcpStatuses = Effect.fn("refreshMcpStatuses")(function* () {
      for (let attempt = 0; attempt < 3; attempt += 1) {
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
        if (
          !shouldPollRequiredMcpStatuses(input.context.mcpStatuses, requiredServerNames) ||
          attempt === 2
        ) {
          break;
        }
        yield* Effect.sleep(100 * 2 ** attempt);
      }
    });

    yield* input.context.refreshMcpStatuses();
    if (!mcpReadinessPolicy(input.context.mcpStatuses, requiredServerNames).requiredReady) {
      return yield* new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId: input.threadId,
        detail: `Required Claude MCP bridge is unavailable: ${requiredServerNames.join(", ")}.`,
      });
    }
  },
);
