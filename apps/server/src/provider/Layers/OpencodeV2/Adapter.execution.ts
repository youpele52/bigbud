import { Effect } from "effect";
import { makeV2RuntimeAdapter } from "./Adapter.runtime.ts";
import { v2TryPromise } from "./Client.guard.async.ts";
import { V2IsolatedMcp } from "./Runtime.mcp.ts";
import type { V2IsolatedRuntimeOptions } from "./Runtime.types.ts";
import { ProviderAdapterValidationError } from "../../Errors.ts";
import { v2ExecutionFailureClass, v2ExecutionIssue } from "./Adapter.execution.errors.ts";

/** Explicit disposable/legacy test entry. Production imports Adapter.shared, never this MCP harness. */
export const makeIsolatedOpencodeV2Adapter = Effect.fn("makeIsolatedOpencodeV2Adapter")(function* (
  options: Omit<V2IsolatedRuntimeOptions, "emit">,
) {
  const result = yield* makeV2RuntimeAdapter(options);
  if (!options.enableIsolatedMcp) return result;
  const mcp = new V2IsolatedMcp(result.runtime);
  const call = <T>(operation: string, run: () => Promise<T>) =>
    v2TryPromise({
      try: () => result.runtime.authorized(run),
      catch: (error) => {
        const issue = v2ExecutionIssue(error);
        return new ProviderAdapterValidationError({
          provider: "opencodeV2",
          operation,
          issue,
          failureClass: v2ExecutionFailureClass(error, issue),
          cause: { name: error instanceof Error ? error.name : "UnknownFailure" },
        });
      },
    });
  return {
    ...result,
    adapter: {
      ...result.adapter,
      mcp: {
        refresh: (thread: Parameters<typeof mcp.refresh>[0]) =>
          call("mcp.refresh", () => mcp.refresh(thread)),
        replace: (
          thread: Parameters<typeof mcp.replace>[0],
          servers: Parameters<typeof mcp.replace>[1],
        ) => call("mcp.replace", () => mcp.replace(thread, servers)),
        reconnect: (
          thread: Parameters<typeof mcp.connect>[0],
          server: Parameters<typeof mcp.connect>[1],
        ) => call("mcp.reconnect", () => mcp.connect(thread, server, true)),
        toggle: (
          thread: Parameters<typeof mcp.connect>[0],
          server: Parameters<typeof mcp.connect>[1],
          enabled: boolean,
        ) => call("mcp.toggle", () => mcp.connect(thread, server, enabled)),
      },
    },
  };
});
