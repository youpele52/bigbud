import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import type { ProjectId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Duration, Effect, Option } from "effect";
import type { WsTransport } from "./wsTransport";

class SshMonitorRpcError extends Error {
  readonly _tag = "SshMonitorRpcError";
}

const SAMPLE_DEADLINE = Option.some(Duration.seconds(10));
const DISCOVERY_DEADLINE = Option.some(Duration.seconds(30));
const monitorError = (cause: unknown) =>
  new SshMonitorRpcError(cause instanceof Error ? cause.message : String(cause));

/** Apply a finite deadline and normalize server errors for the SSH monitor. */
export function requestSshMonitorSample(transport: WsTransport, input: { projectId: ProjectId }) {
  return transport.request(
    (client) =>
      client[WS_METHODS.serverSampleSshMonitor](input).pipe(Effect.mapError(monitorError)),
    { timeout: SAMPLE_DEADLINE },
  );
}

/** Discovery may check several hosts; it still has a finite total request budget. */
export function requestConnectedSshMonitors(transport: WsTransport) {
  return transport.request(
    (client) =>
      client[WS_METHODS.serverListConnectedSshMonitors]({}).pipe(Effect.mapError(monitorError)),
    { timeout: DISCOVERY_DEADLINE },
  );
}
