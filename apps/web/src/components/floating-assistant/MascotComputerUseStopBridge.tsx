import { useEffect, useRef } from "react";
import type { DesktopBridge } from "@bigbud/contracts";

import { getWsConnectionUiState, useWsConnectionStatus } from "~/rpc/wsConnectionState";
import { getWsRpcClient } from "~/rpc/wsRpcClient";

import { announceMascotAttention } from "./mascotAttention.logic";
import {
  type MascotComputerUseStopBridge as Bridge,
  type MascotComputerUseStopFeedback,
  startMascotComputerUseStopBridge,
} from "./mascotComputerUseStop.logic";

function showStopFeedback(bridge: DesktopBridge, feedback: MascotComputerUseStopFeedback): void {
  // The mascot window has no toast surface, so feedback is an OS notification with the
  // pointing pose, as for task-completion notifications.
  announceMascotAttention();
  void bridge.notifications
    .show({ title: feedback.title, body: feedback.body })
    .catch(() => undefined);
}

/** Mascot window only: keeps "Stop computer use" in the mascot menu in sync with the server. */
export function MascotComputerUseStopBridge() {
  const connected = getWsConnectionUiState(useWsConnectionStatus()) === "connected";
  const bridgeRef = useRef<Bridge | null>(null);

  useEffect(() => {
    const bridge = window.desktopBridge;
    const setActive = bridge?.setComputerUseActive;
    const onStopRequested = bridge?.onStopComputerUseRequested;
    if (!bridge || !setActive || !onStopRequested) return;
    const client = getWsRpcClient();
    const started = startMascotComputerUseStopBridge({
      subscribeActivity: (listener) => client.computerUse.subscribeActivity(listener),
      stop: () => client.computerUse.stop(),
      setActive,
      onStopRequested,
      notify: (feedback) => showStopFeedback(bridge, feedback),
    });
    bridgeRef.current = started;
    return () => {
      bridgeRef.current = null;
      started.dispose();
    };
  }, []);

  useEffect(() => {
    bridgeRef.current?.setConnected(connected);
  }, [connected]);

  return null;
}
