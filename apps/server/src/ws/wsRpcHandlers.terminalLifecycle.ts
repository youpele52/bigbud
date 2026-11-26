import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { TerminalExecutionTargetError } from "@bigbud/contracts/workspace/terminal.ts";
import { TerminalLimitError } from "@bigbud/contracts/workspace/terminal.limit.ts";
import type {
  TerminalKeepOpenInput,
  TerminalRetrySetupInput,
} from "@bigbud/contracts/workspace/terminal.lifecycle.ts";
import { observeRpcEffect } from "../observability/RpcInstrumentation";
import type { WsRpcContext } from "./wsRpcContext";

const isTerminalLimitError = Schema.is(TerminalLimitError);

const RETRY_UNAVAILABLE =
  "Retrying a setup script isn't supported by this backend. Run the setup script again from the project menu.";

/** Lifecycle controls (plan S3): Keep open, the setup retry at the limit, and "Close them". */
export function makeWsRpcTerminalLifecycleHandlers(context: WsRpcContext) {
  const setupError = (threadId: string, detail: string, cause?: unknown) =>
    new TerminalExecutionTargetError({
      threadId,
      terminalId: "unknown",
      executionTargetId: "unknown",
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  return {
    [WS_METHODS.terminalKeepOpen]: (input: TerminalKeepOpenInput) =>
      observeRpcEffect(
        WS_METHODS.terminalKeepOpen,
        context.terminalManager?.keepOpen?.(input) ?? Effect.void,
        { "rpc.aggregate": "terminal" },
      ),
    [WS_METHODS.terminalRetrySetup]: (input: TerminalRetrySetupInput) => {
      const retry = context.projectSetupScriptRunner?.retryBlockedSetup;
      return observeRpcEffect(
        WS_METHODS.terminalRetrySetup,
        retry
          ? retry(input).pipe(
              Effect.mapError((error) =>
                // A second refusal names a fresh candidate; the toast asks again with it.
                isTerminalLimitError(error)
                  ? error
                  : setupError(input.threadId, error.message, error),
              ),
            )
          : Effect.fail(setupError(input.threadId, RETRY_UNAVAILABLE)),
        { "rpc.aggregate": "terminal" },
      );
    },
    [WS_METHODS.terminalCloseDrainingHosts]: (_input: Record<string, never>) =>
      observeRpcEffect(
        WS_METHODS.terminalCloseDrainingHosts,
        context.terminalManager?.closeDrainingHosts?.() ??
          Effect.succeed({ closed: 0, remaining: 0 }),
        { "rpc.aggregate": "terminal" },
      ),
  };
}
