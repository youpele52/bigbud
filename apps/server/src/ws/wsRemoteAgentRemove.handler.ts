import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import type { ServerRemoveRemoteAgentInput } from "@bigbud/contracts/server/server.remoteAgentInstall.ts";

import { observeRpcEffect } from "../observability/RpcInstrumentation";
import type { WsRpcContext } from "./wsRpcContext.ts";
import { removeRemoteAgentEffect } from "./wsRemoteAgentRemove.ts";
import { makeRemoveRemoteAgentDependencies } from "./wsRemoteAgentRemove.dependencies.ts";

/** Settings → Remote agents → Remove agent. */
export function makeRemoveRemoteAgentHandlers(context: WsRpcContext) {
  // Composed per request, like Disconnect: handlers are built before every service is used.
  const dependencies = () =>
    makeRemoveRemoteAgentDependencies({
      remoteAgentInstaller: context.remoteAgentInstaller,
      ...(context.remoteAgentUpdateCoordinator
        ? { remoteAgentUpdateCoordinator: context.remoteAgentUpdateCoordinator }
        : {}),
      providerService: context.providerService,
      terminalManager: context.terminalManager,
      workspaces: {
        getReadModel: () => context.orchestrationEngine.getReadModel(),
        getProjectWorktreePaths: (input) =>
          context.projectionCatalogQuery.getProjectWorktreePaths(input),
        // The workspace dialog's Save dispatch. Normalization only trims remote roots, and the
        // stored root is already trimmed, so the command goes straight to the authenticated path.
        dispatch: (command) => context.dispatchNormalizedCommand(command),
      },
    });
  return {
    [WS_METHODS.serverRemoveRemoteAgent]: (input: ServerRemoveRemoteAgentInput) =>
      observeRpcEffect(
        WS_METHODS.serverRemoveRemoteAgent,
        removeRemoteAgentEffect(input, dependencies()),
        { "rpc.aggregate": "server" },
      ),
  };
}
