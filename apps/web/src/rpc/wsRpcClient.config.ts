import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { Duration, Option } from "effect";

import type { WsTransport } from "./wsTransport";

export const CONFIG_FALLBACK_DEADLINE_MS = 15_000;

/** Bounds only the read-only config fallback; mutation request defaults remain unchanged. */
export function requestServerConfig(transport: Pick<WsTransport, "request">) {
  return transport.request((client) => client[WS_METHODS.serverGetConfig]({}), {
    timeout: Option.some(Duration.millis(CONFIG_FALLBACK_DEADLINE_MS)),
  });
}
