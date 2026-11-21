import { TerminalLifecycleRpcs } from "./rpc.terminalLifecycle";
import { TerminalRemoteRpcs } from "./rpc.terminalRemote";
import { WsTerminalRecoveryRpc } from "./rpc.terminalRecovery";
import { WsTerminalShellProfilesRpc } from "./rpc.terminalShellProfiles";
import { WsTerminalSnapshotRpc } from "./rpc.terminalSnapshot";
import {
  WsSubscribeTerminalSessionRpc,
  WsTerminalOutputAckRpc,
  WsTerminalSearchRpc,
  WsTerminalStagePasteFileRpc,
  WsTerminalViewRpc,
} from "./rpc.terminalStream";
import { WsTerminalWslDistributionsRpc } from "./rpc.terminalTargets";
import {
  WsTerminalClearRpc,
  WsTerminalCloseRpc,
  WsTerminalOpenRpc,
  WsTerminalResizeRpc,
  WsTerminalRestartRpc,
  WsTerminalWriteRpc,
} from "./rpc.core";

/** Every terminal RPC except the global `subscribeTerminalEvents` stream (`rpc.stream`). */
export const TerminalRpcs = [
  WsTerminalOpenRpc,
  WsTerminalWriteRpc,
  WsTerminalSnapshotRpc,
  ...TerminalRemoteRpcs,
  WsTerminalRecoveryRpc,
  WsTerminalOutputAckRpc,
  WsTerminalSearchRpc,
  WsTerminalStagePasteFileRpc,
  WsTerminalViewRpc,
  WsSubscribeTerminalSessionRpc,
  WsTerminalWslDistributionsRpc,
  WsTerminalShellProfilesRpc,
  WsTerminalResizeRpc,
  WsTerminalClearRpc,
  WsTerminalRestartRpc,
  WsTerminalCloseRpc,
  ...TerminalLifecycleRpcs,
] as const;
