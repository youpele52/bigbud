/** Mobile websocket RPC client helpers shared by the `server.mobile.*` seam tests. */
import { MobileWsRpcGroup } from "@bigbud/contracts/server/rpc.mobile";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { Effect, Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";

import { wsRpcOpenRetrySchedule } from "./server.test.helpers.ts";

const makeMobileWsRpcClient = RpcClient.make(MobileWsRpcGroup);
type MobileWsRpcClient =
  typeof makeMobileWsRpcClient extends Effect.Effect<infer Client, any, any> ? Client : never;

const mobileWsRpcProtocolLayer = (wsUrl: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(NodeSocket.layerWebSocket(wsUrl)),
    Layer.provide(RpcSerialization.layerJson),
  );

export const withMobileWsRpcClient = <A, E, R>(
  wsUrl: string,
  f: (client: MobileWsRpcClient) => Effect.Effect<A, E, R>,
) => makeMobileWsRpcClient.pipe(Effect.flatMap(f), Effect.provide(mobileWsRpcProtocolLayer(wsUrl)));

export const withRetriedMobileWsRpcClient = <A, E, R>(
  wsUrl: string,
  f: (client: MobileWsRpcClient) => Effect.Effect<A, E, R>,
) =>
  withMobileWsRpcClient(wsUrl, f).pipe(
    Effect.retry({
      schedule: wsRpcOpenRetrySchedule,
      times: 5,
      while: (error) => String(error).includes("SocketOpenError"),
    }),
  );
