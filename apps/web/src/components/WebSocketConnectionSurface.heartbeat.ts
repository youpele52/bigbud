import { useEffect, useRef } from "react";

import { getWsConnectionStatus } from "../rpc/wsConnectionState";
import { getWsRpcClient } from "../rpc/wsRpcClient";
import { getWsInboundActivitySequence, hasWsInboundActivitySince } from "../rpc/wsActivity";
import {
  runWsHeartbeatProbe,
  shouldReconnectAfterHeartbeatFailure,
  WS_HEARTBEAT_FAILURE_THRESHOLD,
  WS_HEARTBEAT_INTERVAL_MS,
} from "../rpc/wsHeartbeat";

export function useWebSocketHeartbeat(connected: boolean, reconnect: () => void): () => void {
  const inFlightRef = useRef(false);
  const failureCountRef = useRef(0);
  const generationRef = useRef(0);
  const reconnectRef = useRef(reconnect);
  reconnectRef.current = reconnect;

  const invalidate = () => {
    generationRef.current += 1;
    failureCountRef.current = 0;
    inFlightRef.current = false;
  };

  useEffect(() => {
    if (!connected) {
      invalidate();
      return;
    }
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    failureCountRef.current = 0;
    inFlightRef.current = false;
    const intervalId = window.setInterval(() => {
      if (inFlightRef.current || getWsConnectionStatus().phase !== "connected") return;
      inFlightRef.current = true;
      const inboundActivitySequence = getWsInboundActivitySequence();
      void runWsHeartbeatProbe(() => getWsRpcClient().server.ping())
        .then((healthy) => {
          if (generationRef.current !== generation) return;
          if (healthy) {
            failureCountRef.current = 0;
            return;
          }
          if (getWsConnectionStatus().phase !== "connected") {
            failureCountRef.current = 0;
            return;
          }
          if (hasWsInboundActivitySince(inboundActivitySequence)) {
            failureCountRef.current = 0;
            console.warn("WebSocket heartbeat probe was delayed while inbound events continued.");
            return;
          }
          failureCountRef.current += 1;
          console.warn("WebSocket heartbeat probe failed while the socket remained connected.", {
            consecutiveFailures: failureCountRef.current,
            failureThreshold: WS_HEARTBEAT_FAILURE_THRESHOLD,
          });
          if (shouldReconnectAfterHeartbeatFailure(failureCountRef.current)) {
            invalidate();
            reconnectRef.current();
          }
        })
        .finally(() => {
          if (generationRef.current === generation) inFlightRef.current = false;
        });
    }, WS_HEARTBEAT_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
      if (generationRef.current === generation) invalidate();
    };
  }, [connected]);

  return invalidate;
}
