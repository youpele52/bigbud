import { Effect, Layer, Option, Schema, Stream } from "effect";
import {
  type ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  OrchestrationReplayEventsError,
  WS_METHODS,
} from "@bigbud/contracts";
import { MobileWsRpcGroup } from "@bigbud/contracts/server/rpc.mobile";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { MobileRemoteControl } from "../mobile/Services/MobileRemoteControl";
import { observeRpcEffect, observeRpcStreamEffect } from "../observability/RpcInstrumentation";
import {
  makeOrderedOrchestrationDomainEventStream,
  makeThinkingActivityDeltaStream,
} from "./wsStreams";
import { makeWsRpcContext } from "./wsRpcContext";

const ALLOWED_MOBILE_COMMAND_TYPES = new Set([
  "thread.turn.start",
  "thread.turn.interrupt",
  "thread.approval.respond",
  "thread.user-input.respond",
  "thread.archive",
]);

const MobileWsRpcLayer = MobileWsRpcGroup.toLayer(
  Effect.gen(function* () {
    const context = yield* makeWsRpcContext;

    return MobileWsRpcGroup.of({
      [ORCHESTRATION_WS_METHODS.getSnapshot]: (_input: unknown) =>
        observeRpcEffect(
          ORCHESTRATION_WS_METHODS.getSnapshot,
          context.projectionSnapshotQuery.getSnapshot().pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationGetSnapshotError({
                  message: "Failed to load orchestration snapshot",
                  cause,
                }),
            ),
          ),
          { "rpc.aggregate": "mobile-orchestration" },
        ),
      [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: unknown) =>
        observeRpcEffect(
          ORCHESTRATION_WS_METHODS.dispatchCommand,
          Effect.gen(function* () {
            const normalizedCommand = yield* context.normalizeDispatchCommand(
              command as ClientOrchestrationCommand,
            );
            if (!ALLOWED_MOBILE_COMMAND_TYPES.has(normalizedCommand.type)) {
              return yield* new OrchestrationDispatchCommandError({
                message: `Command ${normalizedCommand.type} is not available on mobile.`,
              });
            }
            return yield* context.dispatchNormalizedCommand(normalizedCommand);
          }).pipe(
            Effect.mapError((cause) =>
              Schema.is(OrchestrationDispatchCommandError)(cause)
                ? cause
                : new OrchestrationDispatchCommandError({
                    message: "Failed to dispatch orchestration command",
                    cause,
                  }),
            ),
          ),
          { "rpc.aggregate": "mobile-orchestration" },
        ),
      [ORCHESTRATION_WS_METHODS.getTurnDiff]: (input: any) =>
        observeRpcEffect(
          ORCHESTRATION_WS_METHODS.getTurnDiff,
          context.checkpointDiffQuery.getTurnDiff(input).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationGetTurnDiffError({
                  message: "Failed to load turn diff",
                  cause,
                }),
            ),
          ),
          { "rpc.aggregate": "mobile-orchestration" },
        ),
      [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (input: any) =>
        observeRpcEffect(
          ORCHESTRATION_WS_METHODS.getFullThreadDiff,
          context.checkpointDiffQuery.getFullThreadDiff(input).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationGetFullThreadDiffError({
                  message: "Failed to load full thread diff",
                  cause,
                }),
            ),
          ),
          { "rpc.aggregate": "mobile-orchestration" },
        ),
      [ORCHESTRATION_WS_METHODS.replayEvents]: (input: {
        readonly fromSequenceExclusive: number;
      }) =>
        observeRpcEffect(
          ORCHESTRATION_WS_METHODS.replayEvents,
          Stream.runCollect(
            context.orchestrationEngine.readEvents(input.fromSequenceExclusive),
          ).pipe(
            Effect.map((events) => Array.from(events)),
            Effect.mapError(
              (cause) =>
                new OrchestrationReplayEventsError({
                  message: "Failed to replay orchestration events",
                  cause,
                }),
            ),
          ),
          { "rpc.aggregate": "mobile-orchestration" },
        ),
      [WS_METHODS.subscribeOrchestrationDomainEvents]: (_input: unknown) =>
        observeRpcStreamEffect(
          WS_METHODS.subscribeOrchestrationDomainEvents,
          makeOrderedOrchestrationDomainEventStream({
            orchestrationEngine: context.orchestrationEngine,
          }),
          { "rpc.aggregate": "mobile-orchestration" },
        ),
      [WS_METHODS.subscribeThinkingActivityDeltas]: (_input: unknown) =>
        observeRpcStreamEffect(
          WS_METHODS.subscribeThinkingActivityDeltas,
          makeThinkingActivityDeltaStream({
            providerService: context.providerService,
            serverSettings: context.serverSettings,
          }),
          { "rpc.aggregate": "mobile-orchestration" },
        ),
    });
  }),
);

const MobileWsRpcRuntimeLayer = MobileWsRpcLayer.pipe(
  Layer.provideMerge(RpcSerialization.layerJson),
);

export const mobileWebsocketRpcRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(MobileWsRpcGroup, {
      spanPrefix: "mobile.ws.rpc",
      spanAttributes: {
        "rpc.transport": "websocket",
        "rpc.system": "effect-rpc",
      },
    }).pipe(Effect.provide(MobileWsRpcRuntimeLayer));

    return HttpRouter.add(
      "GET",
      "/mobile-ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = HttpServerRequest.toURL(request);
        if (Option.isNone(url)) {
          return HttpServerResponse.text("Invalid WebSocket URL", { status: 400 });
        }
        const token = url.value.searchParams.get("token");
        if (!token) {
          return HttpServerResponse.text("Unauthorized WebSocket connection", { status: 401 });
        }
        const mobileRemoteControl = yield* MobileRemoteControl;
        const session = yield* mobileRemoteControl.validateSessionToken(token);
        if (session === null) {
          return HttpServerResponse.text("Unauthorized WebSocket connection", { status: 401 });
        }
        return yield* rpcWebSocketHttpEffect;
      }),
    );
  }),
);
