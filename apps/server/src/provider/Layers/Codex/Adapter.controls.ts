import { Effect } from "effect";
import type { CodexAppServerManager } from "../../../codex/codexAppServerManager.ts";
import type { CodexAdapterShape } from "../../Services/Codex/Adapter.ts";
import { toRequestError } from "./Adapter.session.shared.ts";

/** Reuses the optional MCP surface; unsupported operations never issue native RPCs. */
export function makeCodexControls(manager: CodexAppServerManager, deliveryFailure: () => unknown) {
  const controls: NonNullable<CodexAdapterShape["controls"]> = (input) =>
    Effect.tryPromise({
      try: () => {
        if (deliveryFailure()) throw new Error("Codex event delivery is unavailable.");
        return manager.providerControls(input);
      },
      catch: (cause) => toRequestError(input.threadId, "provider/controls", cause),
    });
  const unsupported = (threadId: Parameters<CodexAdapterShape["hasSession"]>[0]) =>
    Effect.fail(
      toRequestError(
        threadId,
        "mcp/unsupported",
        new Error(
          "Targeted reconnect, toggle and replace are unavailable. Use Reload all MCP servers.",
        ),
      ),
    );
  const mcp: NonNullable<CodexAdapterShape["mcp"]> = {
    refresh: (threadId) =>
      Effect.gen(function* () {
        const session = manager.listSessions().find((entry) => entry.threadId === threadId);
        if (session?.sessionEpoch === undefined) return yield* unsupported(threadId);
        const snapshot = yield* controls({
          threadId,
          sessionEpoch: session.sessionEpoch,
          action: "refresh-mcp",
        });
        if (!snapshot.servers)
          return yield* Effect.fail(
            toRequestError(
              threadId,
              "mcpServerStatus/list",
              new Error("MCP status refresh failed."),
            ),
          );
        return snapshot.servers;
      }),
    reloadAll: (threadId, sessionEpoch) =>
      controls({ threadId, sessionEpoch, action: "reload-mcp" }),
    reconnect: unsupported,
    toggle: unsupported,
    replace: unsupported,
  };
  return {
    controls,
    mcp,
    confirmCompaction: (
      input: import("../../Services/ProviderCompaction.ts").CodexCompactionConfirmation,
      persisted: boolean,
    ) => Effect.sync(() => manager.confirmCompaction(input, persisted)),
  };
}
