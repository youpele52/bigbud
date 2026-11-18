import { useEffect, useRef } from "react";

import { type SlowRpcAckRequest, useSlowRpcAckRequests } from "../rpc/requestLatencyState";
import { getWsConnectionUiState, useWsConnectionStatus } from "../rpc/wsConnectionState";
import { toastManager } from "./ui/toast";

export const SLOW_RPC_ACK_TOAST_CONDITION = "slow-rpc-ack";

function describeSlowRpcAckToast(requests: ReadonlyArray<SlowRpcAckRequest>): string {
  const count = requests.length;
  const thresholdSeconds = Math.round((requests[0]?.thresholdMs ?? 0) / 1000);
  return `${count} request${count === 1 ? "" : "s"} waiting longer than ${thresholdSeconds}s.`;
}

export function SlowRpcAckToastCoordinator() {
  const slowRequests = useSlowRpcAckRequests();
  const status = useWsConnectionStatus();
  const toastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);

  useEffect(() => {
    if (getWsConnectionUiState(status) !== "connected" || slowRequests.length === 0) {
      if (toastIdRef.current) toastManager.close(toastIdRef.current);
      toastIdRef.current = null;
      return;
    }
    // An ongoing condition: the shared toast policy auto-dismisses it and keeps a
    // dismissed notice quiet for a cool-down even though the count keeps changing.
    const toast = {
      data: { conditionKey: SLOW_RPC_ACK_TOAST_CONDITION },
      description: describeSlowRpcAckToast(slowRequests),
      timeout: 0,
      title: "Some requests are slow",
      type: "warning" as const,
    };
    if (toastIdRef.current) toastManager.update(toastIdRef.current, toast);
    else toastIdRef.current = toastManager.add(toast);
  }, [slowRequests, status]);

  return null;
}
