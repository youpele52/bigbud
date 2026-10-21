import { useEffect, useRef } from "react";

import { getWsConnectionStatus } from "../rpc/wsConnectionState";
import { getWsRpcClient } from "../rpc/wsRpcClient";
import { getWsInboundActivitySequence, hasWsInboundActivitySince } from "../rpc/wsActivity";
import { queueWsConnectionDiagnosticsReport } from "../rpc/wsConnectionDiagnosticsReporter";
import {
  runWsHeartbeatProbe,
  shouldReconnectAfterHeartbeatFailure,
  WS_HEARTBEAT_FAILURE_THRESHOLD,
  WS_HEARTBEAT_INTERVAL_MS,
} from "../rpc/wsHeartbeat";

export interface WebSocketHeartbeatControls {
  /** Drops in-flight probes and the failure count, e.g. on suspend or a forced reconnect. */
  readonly invalidate: () => void;
  /** Starts a probe now instead of waiting for the next interval, e.g. after a wake. */
  readonly probeNow: () => void;
}

export function useWebSocketHeartbeat(
  connected: boolean,
  reconnect: () => void,
): WebSocketHeartbeatControls {
  const inFlightRef = useRef(false);
  const failureCountRef = useRef(0);
  // Bumped by `invalidate`: results of probes started under an older epoch never count.
  const probeEpochRef = useRef(0);
  const generationRef = useRef(0);
  const probeRef = useRef<(() => void) | null>(null);
  const reconnectRef = useRef(reconnect);
  reconnectRef.current = reconnect;

  const invalidate = () => {
    probeEpochRef.current += 1;
    failureCountRef.current = 0;
    inFlightRef.current = false;
  };
  const controlsRef = useRef<WebSocketHeartbeatControls>({
    invalidate,
    probeNow: () => probeRef.current?.(),
  });

  useEffect(() => {
    if (!connected) {
      invalidate();
      return;
    }
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    invalidate();
    const probe = () => {
      if (generationRef.current !== generation) return;
      if (inFlightRef.current || getWsConnectionStatus().phase !== "connected") return;
      inFlightRef.current = true;
      const epoch = probeEpochRef.current;
      const isCurrent = () =>
        generationRef.current === generation && probeEpochRef.current === epoch;
      const inboundActivitySequence = getWsInboundActivitySequence();
      let probeAgain = false;
      void runWsHeartbeatProbe(() => getWsRpcClient().server.ping())
        .then((healthy) => {
          if (!isCurrent()) return;
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
            queueWsConnectionDiagnosticsReport({
              trigger: "heartbeat-failure",
              detail: `consecutiveFailures=${failureCountRef.current}`,
            });
            invalidate();
            reconnectRef.current();
            return;
          }
          // Confirm a suspected dead socket immediately rather than on the next tick.
          probeAgain = true;
        })
        .finally(() => {
          if (!isCurrent()) return;
          inFlightRef.current = false;
          if (probeAgain) probe();
        });
    };
    probeRef.current = probe;
    const intervalId = window.setInterval(probe, WS_HEARTBEAT_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
      if (probeRef.current === probe) probeRef.current = null;
      if (generationRef.current === generation) {
        generationRef.current += 1;
        invalidate();
      }
    };
  }, [connected]);

  return controlsRef.current;
}
