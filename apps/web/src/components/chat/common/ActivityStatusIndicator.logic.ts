import {
  formatWsReconnectAttempt,
  isWsReconnecting,
  type WsConnectionStatus,
} from "~/rpc/wsConnectionState";

export interface ActivityStatus {
  kind: "reconnecting" | "compacting" | "working";
  label: string;
}

/** Connection recovery takes precedence over provider activity until updates can resume. */
export function resolveActivityStatus({
  connection,
  isCompacting,
  verb,
}: {
  connection: WsConnectionStatus;
  isCompacting: boolean;
  verb: string;
}): ActivityStatus {
  if (isWsReconnecting(connection)) {
    return { kind: "reconnecting", label: `Reconnecting ${formatWsReconnectAttempt(connection)}` };
  }
  if (isCompacting) {
    return { kind: "compacting", label: "Compacting..." };
  }
  return { kind: "working", label: verb };
}
