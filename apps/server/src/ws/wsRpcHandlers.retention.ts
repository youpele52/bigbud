import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import type {
  ServerPreviewThreadRetentionInput,
  ServerSetThreadRetentionPolicyInput,
  ServerStartThreadRetentionInput,
} from "@bigbud/contracts/server/threadRetention.ts";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import type { WsRpcContext } from "./wsRpcContext.ts";

export function makeThreadRetentionWsRpcHandlers(context: WsRpcContext) {
  return {
    [WS_METHODS.serverPreviewThreadRetention]: (input: ServerPreviewThreadRetentionInput) =>
      observeRpcEffect(
        WS_METHODS.serverPreviewThreadRetention,
        context.threadRetention.preview(input),
        {
          "rpc.aggregate": "server",
        },
      ),
    [WS_METHODS.serverStartThreadRetention]: (input: ServerStartThreadRetentionInput) =>
      observeRpcEffect(
        WS_METHODS.serverStartThreadRetention,
        context.threadRetention.enqueue(input),
        {
          "rpc.aggregate": "server",
        },
      ),
    [WS_METHODS.serverSetThreadRetentionPolicy]: (input: ServerSetThreadRetentionPolicyInput) =>
      observeRpcEffect(
        WS_METHODS.serverSetThreadRetentionPolicy,
        context.threadRetention.setPolicy(input),
        { "rpc.aggregate": "server" },
      ),
  };
}
