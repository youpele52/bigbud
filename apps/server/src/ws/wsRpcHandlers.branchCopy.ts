import { ORCHESTRATION_WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import {
  OrchestrationGetThreadBranchCopyError,
  OrchestrationStartThreadBranchError,
  type GetThreadBranchCopyInput,
  type StartThreadBranchInput,
} from "@bigbud/contracts/orchestration/orchestration.branchCopy.ts";
import { Effect, Option } from "effect";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import type { WsRpcContext } from "./wsRpcContext.ts";

const UNAVAILABLE = "Branching is unavailable on this server.";

/** Server-side branches: the client sends ids and metadata; the server copies the messages. */
export function makeBranchCopyWsRpcHandlers(context: WsRpcContext) {
  return {
    [ORCHESTRATION_WS_METHODS.startThreadBranch]: (input: StartThreadBranchInput) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.startThreadBranch,
        Option.isSome(context.threadBranchCopy)
          ? context.threadBranchCopy.value.start(input)
          : Effect.fail(new OrchestrationStartThreadBranchError({ message: UNAVAILABLE })),
        { "rpc.aggregate": "orchestration" },
      ),
    [ORCHESTRATION_WS_METHODS.getThreadBranchCopy]: (input: GetThreadBranchCopyInput) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.getThreadBranchCopy,
        Option.isSome(context.threadBranchCopy)
          ? context.threadBranchCopy.value.status(input.branchThreadId).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetThreadBranchCopyError({
                    message: "Failed to read the branch copy",
                    cause,
                  }),
              ),
            )
          : Effect.succeed(null),
        { "rpc.aggregate": "orchestration" },
      ),
  };
}
