import { WS_METHODS } from "@bigbud/contracts";

import type { WsTransport } from "./wsTransport";
import type { WsRpcClient } from "./wsRpcClient.types";

export function createTerminalRpcClient(transport: WsTransport): WsRpcClient["terminal"] {
  return {
    wslDistributions: () =>
      transport.request((client) => client[WS_METHODS.terminalWslDistributions]({})),
    snapshot: (input) => transport.request((client) => client[WS_METHODS.terminalSnapshot](input)),
    open: (input) => transport.request((client) => client[WS_METHODS.terminalOpen](input)),
    write: (input) => transport.request((client) => client[WS_METHODS.terminalWrite](input)),
    resize: (input) => transport.request((client) => client[WS_METHODS.terminalResize](input)),
    clear: (input) => transport.request((client) => client[WS_METHODS.terminalClear](input)),
    restart: (input) => transport.request((client) => client[WS_METHODS.terminalRestart](input)),
    close: (input) => transport.request((client) => client[WS_METHODS.terminalClose](input)),
    // Mounted views receive output on their own scoped streams; this feed keeps only the output
    // that client-side (remote/WSL) agent detection needs, plus every lifecycle event.
    onEvent: (listener, options) =>
      transport.subscribe(
        (client) => client[WS_METHODS.subscribeTerminalEvents]({ outputScope: "legacyDetection" }),
        listener,
        options,
      ),
    subscribeSession: (input, listener, options) =>
      transport.subscribe(
        (client) => client[WS_METHODS.subscribeTerminalSession](input),
        listener,
        options,
      ),
    ackOutput: (input) =>
      transport.request((client) => client[WS_METHODS.terminalOutputAck](input)),
    search: (input) => transport.request((client) => client[WS_METHODS.terminalSearch](input)),
  };
}
