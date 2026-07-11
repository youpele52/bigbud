import { Effect, Stream } from "effect";
import {
  type VisibleBrowserCommand,
  type VisibleBrowserCommandResult,
  type VisibleBrowserLeaseRevokeInput,
  type VisibleBrowserRendererId,
  WS_METHODS,
} from "@bigbud/contracts";

import { observeRpcEffect, observeRpcStreamEffect } from "../observability/RpcInstrumentation";
import { getVisibleBrowserControl } from "../browser/Services/VisibleBrowserControl.ts";

export function makeWsRpcBrowserHandlers() {
  return {
    [WS_METHODS.subscribeVisibleBrowserCommands]: (input: {
      readonly rendererId: VisibleBrowserRendererId;
    }) =>
      observeRpcStreamEffect(
        WS_METHODS.subscribeVisibleBrowserCommands,
        Effect.succeed<Stream.Stream<VisibleBrowserCommand>>(
          getVisibleBrowserControl()?.streamCommands(input.rendererId) ?? Stream.empty,
        ),
        { "rpc.aggregate": "browser" },
      ),
    [WS_METHODS.completeVisibleBrowserCommand]: (input: VisibleBrowserCommandResult) =>
      observeRpcEffect(
        WS_METHODS.completeVisibleBrowserCommand,
        getVisibleBrowserControl()?.complete(input) ?? Effect.void,
        { "rpc.aggregate": "browser" },
      ),
    [WS_METHODS.revokeVisibleBrowserLease]: (input: VisibleBrowserLeaseRevokeInput) =>
      observeRpcEffect(
        WS_METHODS.revokeVisibleBrowserLease,
        getVisibleBrowserControl()?.revokeLease(input) ?? Effect.void,
        { "rpc.aggregate": "browser" },
      ),
    [WS_METHODS.getVisibleBrowserLeases]: (input: {
      readonly rendererId: VisibleBrowserRendererId;
    }) =>
      observeRpcEffect(
        WS_METHODS.getVisibleBrowserLeases,
        getVisibleBrowserControl()?.getLeases(input.rendererId) ?? Effect.succeed([]),
        { "rpc.aggregate": "browser" },
      ),
  };
}
