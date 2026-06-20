import { Effect } from "effect";
import { TeachListProjectsError, WS_METHODS } from "@bigbud/contracts";

import { listTeachLearningProjects } from "../teach/TeachLearningProjects.ts";
import { resolveDefaultChatCwd } from "./serverSettings.ts";
import { observeRpcEffect } from "../observability/RpcInstrumentation";
import type { WsRpcContext } from "./wsRpcContext";

export function makeWsRpcTeachHandlers(context: WsRpcContext) {
  return {
    [WS_METHODS.teachListProjects]: () =>
      observeRpcEffect(
        WS_METHODS.teachListProjects,
        Effect.gen(function* () {
          const settings = yield* context.serverSettings.getSettings;
          const defaultChatCwd = resolveDefaultChatCwd(settings);
          return yield* listTeachLearningProjects({
            fileSystem: context.fileSystem,
            defaultChatCwd,
          });
        }).pipe(
          Effect.mapError(
            (cause) =>
              new TeachListProjectsError({
                message: "Failed to list learning projects",
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "teach" },
      ),
  };
}
