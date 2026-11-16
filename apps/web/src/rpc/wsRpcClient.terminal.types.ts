import type { NativeApi } from "@bigbud/contracts";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import type { WsRpcProtocolClient } from "./protocol";
import type {
  RpcUnaryMethod,
  RpcUnaryNoArgMethod,
  RpcStreamMethod,
  StreamSubscriptionOptions,
} from "./wsRpcClient.types";
type RpcInput<T extends keyof WsRpcProtocolClient> = Parameters<WsRpcProtocolClient[T]>[0];

export interface TerminalRpcClient {
  readonly remoteInventory: RpcUnaryMethod<typeof WS_METHODS.terminalRemoteInventory>;
  readonly remoteAttach: RpcUnaryMethod<typeof WS_METHODS.terminalRemoteAttach>;
  readonly remoteDetach: RpcUnaryMethod<typeof WS_METHODS.terminalRemoteDetach>;
  readonly remoteStop: RpcUnaryMethod<typeof WS_METHODS.terminalRemoteStop>;

  readonly shellProfiles: RpcUnaryMethod<typeof WS_METHODS.terminalShellProfiles>;
  readonly wslDistributions: RpcUnaryNoArgMethod<typeof WS_METHODS.terminalWslDistributions>;
  readonly snapshot: RpcUnaryMethod<typeof WS_METHODS.terminalSnapshot>;
  readonly recovery: RpcUnaryMethod<typeof WS_METHODS.terminalRecovery>;
  readonly open: RpcUnaryMethod<typeof WS_METHODS.terminalOpen>;
  readonly write: RpcUnaryMethod<typeof WS_METHODS.terminalWrite>;
  readonly resize: RpcUnaryMethod<typeof WS_METHODS.terminalResize>;
  readonly clear: RpcUnaryMethod<typeof WS_METHODS.terminalClear>;
  readonly restart: RpcUnaryMethod<typeof WS_METHODS.terminalRestart>;
  readonly close: RpcUnaryMethod<typeof WS_METHODS.terminalClose>;
  readonly onEvent: (
    listener: Parameters<NativeApi["terminal"]["onEvent"]>[0],
    options?: StreamSubscriptionOptions & Parameters<NativeApi["terminal"]["onEvent"]>[1],
  ) => () => void;
  readonly subscribeSession: (
    input: RpcInput<typeof WS_METHODS.subscribeTerminalSession>,
    listener: Parameters<RpcStreamMethod<typeof WS_METHODS.subscribeTerminalSession>>[0],
    options?: StreamSubscriptionOptions,
  ) => () => void;
  readonly ackOutput: RpcUnaryMethod<typeof WS_METHODS.terminalOutputAck>;
  readonly search: RpcUnaryMethod<typeof WS_METHODS.terminalSearch>;
}
