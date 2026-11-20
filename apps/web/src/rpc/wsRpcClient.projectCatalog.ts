import { ORCHESTRATION_WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import type { NativeApi } from "@bigbud/contracts/server/ipc.nativeApi.ts";
import { Duration, Option } from "effect";
import type { WsTransport } from "./wsTransport";

/** Bound read-only work at the transport too, including waiting for initial readiness. */
export function requestProjectCatalog(
  transport: Pick<WsTransport, "request">,
  input: Parameters<NativeApi["orchestration"]["getStartupProjectCatalog"]>[0],
) {
  return transport.request(
    (client) => client[ORCHESTRATION_WS_METHODS.getStartupProjectCatalog](input),
    {
      timeout: Option.some(Duration.millis(10_000)),
    },
  );
}
