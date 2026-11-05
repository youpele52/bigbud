import { WS_METHODS } from "@bigbud/contracts";

import type { WsTransport } from "./wsTransport";
import type { WsRpcClient } from "./wsRpcClient.types";

export function createComputerUseRpcClient(transport: WsTransport): WsRpcClient["computerUse"] {
  return {
    subscribeActivity: (listener, options) =>
      transport.subscribe(
        (client) => client[WS_METHODS.subscribeComputerUseActivity]({}),
        listener,
        options,
      ),
    stop: () => transport.request((client) => client[WS_METHODS.computerUseStop]({})),
  };
}
