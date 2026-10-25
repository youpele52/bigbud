import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import type { ServerGetWsConnectionDiagnosticsInput } from "@bigbud/contracts/server/connectionDiagnostics.ts";
import { Duration, Option } from "effect";

import { isOptionalWsRpcUnsupported, WsOptionalRpcUnsupportedError } from "./protocol.optionalRpc";
import type { WsTransport } from "./wsTransport";

const DIAGNOSTICS_READ_METHOD = WS_METHODS.serverGetWsConnectionDiagnostics;
const DIAGNOSTICS_READ_DEADLINE = Option.some(Duration.seconds(10));

/** Read-only diagnostics for settings; a server without the RPC is not asked again. */
export function requestWsConnectionDiagnostics(
  transport: Pick<WsTransport, "request">,
  input: ServerGetWsConnectionDiagnosticsInput,
) {
  if (isOptionalWsRpcUnsupported(DIAGNOSTICS_READ_METHOD)) {
    return Promise.reject(new WsOptionalRpcUnsupportedError(DIAGNOSTICS_READ_METHOD));
  }
  return transport.request((client) => client[DIAGNOSTICS_READ_METHOD](input), {
    timeout: DIAGNOSTICS_READ_DEADLINE,
  });
}
