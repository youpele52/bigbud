import { forgetOrganizationEngagementCaller } from "../thread-organization/organizationEngagement.ts";
import { Effect, Queue } from "effect";
import { WsRpcGroup } from "@bigbud/contracts";
import { RpcServer } from "effect/unstable/rpc";
import { forgetSshMonitorCaller, sshMonitorCallerId } from "../ssh/sshMonitor.connections.ts";

/** Consume each authoritative protocol close once, then forward it to Effect RPC's own cleanup. */
export const bridgeSshMonitorDisconnects = Effect.fn("bridgeSshMonitorDisconnects")(function* (
  source: Queue.Dequeue<number>,
  instanceId: string,
) {
  const forwarded = yield* Queue.unbounded<number>();
  yield* Effect.forever(
    Queue.take(source).pipe(
      Effect.tap((clientId) =>
        Effect.sync(() => {
          const caller = sshMonitorCallerId(instanceId, clientId);
          forgetSshMonitorCaller(caller);
          if (caller) forgetOrganizationEngagementCaller(caller);
        }),
      ),
      Effect.flatMap((clientId) => Queue.offer(forwarded, clientId)),
    ),
  ).pipe(Effect.forkScoped);
  return forwarded;
});

/** Mirrors Effect RPC's WebSocket setup while exposing its disconnect queue for lease cleanup. */
export const makeWsRpcHttpEffectWithSshMonitorCleanup = Effect.fn(
  "makeWsRpcHttpEffectWithSshMonitorCleanup",
)(function* (instanceId: string) {
  const { httpEffect, protocol } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
  const disconnects = yield* bridgeSshMonitorDisconnects(protocol.disconnects, instanceId);
  yield* RpcServer.make(WsRpcGroup, {
    disableFatalDefects: true,
    spanPrefix: "ws.rpc",
    spanAttributes: { "rpc.transport": "websocket", "rpc.system": "effect-rpc" },
  }).pipe(
    Effect.provideService(RpcServer.Protocol, { ...protocol, disconnects }),
    Effect.forkScoped,
  );
  return httpEffect;
});
