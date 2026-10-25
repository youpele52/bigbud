import type { ServerStalledPayload } from "@bigbud/contracts/server/connectionDiagnostics.ts";
import { useEffect, useEffectEvent, useRef } from "react";

import { APP_SERVER_NAME } from "../config/branding";
import { useLatestServerStall, type ServerStallNotice } from "../rpc/serverStallState";
import {
  describeServerStall,
  RECOVERED_TOAST_VISIBLE_MS,
} from "./WebSocketConnectionSurface.toasts";

/** A freeze begins before the heartbeat notices it (about 20 s), so look back this far. */
export const STALL_DROP_LEAD_MS = 30_000;
/** A stall reported this long after the reconnect no longer explains it in the UI. */
export const STALL_LATE_EXPLANATION_MS = 60_000;

export interface ConnectionDrop {
  readonly disconnectedAt: string;
  readonly reconnectedAt: string | null;
}

/**
 * The server publishes `stalled` only after a freeze ends, so it can only explain a drop
 * after the fact. It never says the server is stalled now and never changes reconnect timing.
 */
export function stallExplainsDrop(payload: ServerStalledPayload, drop: ConnectionDrop): boolean {
  const startedAt = Date.parse(payload.startedAt);
  const endedAt = Date.parse(payload.endedAt);
  const disconnectedAt = Date.parse(drop.disconnectedAt);
  if (![startedAt, endedAt, disconnectedAt].every(Number.isFinite)) return false;
  if (endedAt < disconnectedAt - STALL_DROP_LEAD_MS) return false;
  if (drop.reconnectedAt === null) return true;
  const reconnectedAt = Date.parse(drop.reconnectedAt);
  return !Number.isFinite(reconnectedAt) || startedAt <= reconnectedAt;
}

/** Blue: explains an earlier drop whose recovery toast is already gone. */
export function buildServerStallExplanationToast(payload: ServerStalledPayload) {
  return {
    type: "info" as const,
    title: `Why ${APP_SERVER_NAME} disconnected`,
    description: describeServerStall(payload),
    data: {
      dismissAfterVisibleMs: RECOVERED_TOAST_VISIBLE_MS,
      hideCopyButton: true,
    },
  };
}

interface TrackedDrop extends ConnectionDrop {
  readonly recoveredAtMs: number;
  explained: boolean;
}

/**
 * Pairs stall reports with connection drops. At recovery the latest matching stall is
 * folded into the recovery toast; a stall that arrives shortly after is passed to
 * `onLateExplanation` once. Unrelated stalls stay in diagnostics only.
 */
export function useServerStallExplanation(
  onLateExplanation: (payload: ServerStalledPayload) => void,
) {
  const stall = useLatestServerStall();
  const latestStallRef = useRef<ServerStallNotice | null>(null);
  const usedStallIdRef = useRef<number | null>(null);
  const lastDropRef = useRef<TrackedDrop | null>(null);
  const reportLate = useEffectEvent(onLateExplanation);

  useEffect(() => {
    latestStallRef.current = stall;
    const drop = lastDropRef.current;
    if (!stall || !drop || drop.explained || usedStallIdRef.current === stall.id) return;
    if (Date.now() - drop.recoveredAtMs > STALL_LATE_EXPLANATION_MS) return;
    if (!stallExplainsDrop(stall.payload, drop)) return;
    drop.explained = true;
    usedStallIdRef.current = stall.id;
    reportLate(stall.payload);
  }, [stall]);

  /** Records a recovered drop and returns the stall that explains it, if one already arrived. */
  const explainRecovery = (drop: ConnectionDrop): ServerStalledPayload | null => {
    const tracked: TrackedDrop = { ...drop, recoveredAtMs: Date.now(), explained: false };
    lastDropRef.current = tracked;
    const latest = latestStallRef.current;
    if (!latest || usedStallIdRef.current === latest.id) return null;
    if (!stallExplainsDrop(latest.payload, drop)) return null;
    tracked.explained = true;
    usedStallIdRef.current = latest.id;
    return latest.payload;
  };

  // Stable identity: it only touches refs, so effects can list it as a dependency.
  const controlsRef = useRef({ explainRecovery });
  return controlsRef.current;
}
