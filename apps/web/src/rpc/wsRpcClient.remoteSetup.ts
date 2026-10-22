import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import type { ServerListRemoteFoldersInput } from "@bigbud/contracts/server/server.remoteFolders.ts";
import type { ServerListSshConfigHostsInput } from "@bigbud/contracts/server/server.sshConfig.ts";

import { isOptionalWsRpcUnsupported, WsOptionalRpcUnsupportedError } from "./protocol.optionalRpc";
import type { WsTransport } from "./wsTransport";

/** Remote-project setup RPCs; an older server without them fails only the request. */
export function requestSshConfigHosts(
  transport: Pick<WsTransport, "request">,
  input: ServerListSshConfigHostsInput,
) {
  const method = WS_METHODS.serverListSshConfigHosts;
  if (isOptionalWsRpcUnsupported(method)) {
    return Promise.reject(new WsOptionalRpcUnsupportedError(method));
  }
  return transport.request((client) => client[method](input));
}

export function requestRemoteFolders(
  transport: Pick<WsTransport, "request">,
  input: ServerListRemoteFoldersInput,
) {
  const method = WS_METHODS.serverListRemoteFolders;
  if (isOptionalWsRpcUnsupported(method)) {
    return Promise.reject(new WsOptionalRpcUnsupportedError(method));
  }
  return transport.request((client) => client[method](input));
}
