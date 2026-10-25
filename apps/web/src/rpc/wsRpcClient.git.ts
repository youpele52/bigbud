import { type GitRunStackedActionResult, WS_METHODS } from "@bigbud/contracts";

import { randomUUID } from "~/lib/utils";

import type { WsTransport } from "./wsTransport";
import type { GitRunStackedActionOptions, WsRpcClient } from "./wsRpcClient.types";

export function runGitStackedAction(
  transport: WsTransport,
  input: Parameters<WsRpcClient["git"]["runStackedAction"]>[0],
  options?: GitRunStackedActionOptions,
) {
  let result: GitRunStackedActionResult | null = null;

  return transport
    .requestStream(
      (client) => client[WS_METHODS.gitRunStackedAction](input),
      (event) => {
        options?.onProgress?.(event);
        if (event.kind === "action_finished") {
          result = event.result;
        }
      },
    )
    .then(() => {
      if (result) {
        return result;
      }
      throw new Error("Git action stream completed without a final result.");
    });
}

export function withGitMutationOperationId<T extends { operationId?: string | undefined }>(
  input: T,
): T {
  return input.operationId ? input : { ...input, operationId: `git-rpc-${randomUUID()}` };
}
