import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { WS_METHODS } from "../constants/websocket.constant";
import {
  VisibleBrowserCommand,
  VisibleBrowserCommandResult,
  VisibleBrowserCommandStreamInput,
  VisibleBrowserLeaseRevokeInput,
  VisibleBrowserLeaseSnapshot,
} from "../orchestration/visibleBrowser";

export const WsSubscribeVisibleBrowserCommandsRpc = Rpc.make(
  WS_METHODS.subscribeVisibleBrowserCommands,
  {
    payload: VisibleBrowserCommandStreamInput,
    success: VisibleBrowserCommand,
    stream: true,
  },
);

export const WsCompleteVisibleBrowserCommandRpc = Rpc.make(
  WS_METHODS.completeVisibleBrowserCommand,
  {
    payload: VisibleBrowserCommandResult,
    success: Schema.Void,
  },
);

export const WsRevokeVisibleBrowserLeaseRpc = Rpc.make(WS_METHODS.revokeVisibleBrowserLease, {
  payload: VisibleBrowserLeaseRevokeInput,
  success: Schema.Void,
});

export const WsGetVisibleBrowserLeasesRpc = Rpc.make(WS_METHODS.getVisibleBrowserLeases, {
  payload: VisibleBrowserCommandStreamInput,
  success: Schema.Array(VisibleBrowserLeaseSnapshot),
});
