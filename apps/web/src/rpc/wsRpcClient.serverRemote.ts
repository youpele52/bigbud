import type { NativeApi } from "@bigbud/contracts/server/ipc.nativeApi.ts";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import type { WsTransport } from "./wsTransport";
import { requestRemoteFolders, requestSshConfigHosts } from "./wsRpcClient.remoteSetup";

/** Existing remote setup methods split by concern without changing their transport semantics. */
export function createServerRemoteRpcMethods(
  transport: WsTransport,
): Pick<
  NativeApi["server"],
  | "listSshConfigHosts"
  | "listRemoteFolders"
  | "installRemoteAgent"
  | "getRemoteAgentManualInstall"
  | "connectRemoteAgent"
  | "restartRemoteAgent"
  | "getRemoteAgentRestartStatus"
  | "disconnectExecutionTarget"
  | "connectExecutionTarget"
  | "listDisconnectedExecutionTargets"
  | "getRemoteAgentUpdateStatus"
  | "unlockSshKey"
  | "unlockSshPassword"
  | "trustSshHost"
> {
  return {
    listSshConfigHosts: (input) => requestSshConfigHosts(transport, input),
    listRemoteFolders: (input) => requestRemoteFolders(transport, input),
    installRemoteAgent: (input) =>
      transport.request((client) => client[WS_METHODS.serverInstallRemoteAgent](input)),
    getRemoteAgentManualInstall: (input) =>
      transport.request((client) => client[WS_METHODS.serverGetRemoteAgentManualInstall](input)),
    connectRemoteAgent: (input) =>
      transport.request((client) => client[WS_METHODS.serverConnectRemoteAgent](input)),
    restartRemoteAgent: (input) =>
      transport.request((client) => client[WS_METHODS.serverRestartRemoteAgent](input)),
    getRemoteAgentRestartStatus: (input) =>
      transport.request((client) => client[WS_METHODS.serverGetRemoteAgentRestartStatus](input)),
    disconnectExecutionTarget: (input) =>
      transport.request((client) => client[WS_METHODS.serverDisconnectExecutionTarget](input)),
    connectExecutionTarget: (input) =>
      transport.request((client) => client[WS_METHODS.serverConnectExecutionTarget](input)),
    listDisconnectedExecutionTargets: () =>
      transport.request((client) => client[WS_METHODS.serverListDisconnectedExecutionTargets]({})),
    getRemoteAgentUpdateStatus: (input) =>
      transport.request((client) => client[WS_METHODS.serverGetRemoteAgentUpdateStatus](input)),
    unlockSshKey: (input) =>
      transport.request((client) => client[WS_METHODS.serverUnlockSshKey](input)),
    unlockSshPassword: (input) =>
      transport.request((client) => client[WS_METHODS.serverUnlockSshPassword](input)),
    trustSshHost: (input) =>
      transport.request((client) => client[WS_METHODS.serverTrustSshHost](input)),
  };
}
