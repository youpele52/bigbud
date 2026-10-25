import type { DesktopBackendStartReason } from "@bigbud/contracts/server/desktopLifecycleHint.ts";

export interface BackendBootstrapEnvelopeInput {
  readonly port: number;
  readonly host: string;
  readonly t3Home: string;
  readonly authToken: string;
  readonly systemMonitorAgentAccess?: { readonly endpoint: string; readonly token: string } | null;
  readonly otlpTracesUrl?: string | undefined;
  readonly otlpMetricsUrl?: string | undefined;
  readonly startReason?: DesktopBackendStartReason | null;
  /** Child fd of the lifecycle hint pipe, when spawn opened it. The server reads only this. */
  readonly lifecycleHintFd?: number | null;
  readonly ownershipHandoff?: boolean;
}

/** The fd 3 bootstrap line; optional fields are omitted when absent. */
export function buildBackendBootstrapEnvelope(input: BackendBootstrapEnvelopeInput): string {
  return `${JSON.stringify({
    mode: "desktop",
    ...(input.ownershipHandoff ? { ownershipHandoff: true } : {}),
    noBrowser: true,
    port: input.port,
    host: input.host,
    t3Home: input.t3Home,
    authToken: input.authToken,
    ...(input.systemMonitorAgentAccess
      ? { systemMonitorAgentAccess: input.systemMonitorAgentAccess }
      : {}),
    ...(input.otlpTracesUrl ? { otlpTracesUrl: input.otlpTracesUrl } : {}),
    ...(input.otlpMetricsUrl ? { otlpMetricsUrl: input.otlpMetricsUrl } : {}),
    ...(input.startReason ? { startReason: input.startReason } : {}),
    ...(input.lifecycleHintFd != null ? { lifecycleHintFd: input.lifecycleHintFd } : {}),
  })}\n`;
}

let pendingStartReason: DesktopBackendStartReason | null = null;

/** Records why the next backend start happens, for example a post-wake restart. */
export function markNextBackendStartReason(reason: DesktopBackendStartReason): void {
  pendingStartReason = reason;
}

/**
 * Returns and clears the pending start reason once a backend has been spawned
 * and is about to receive its envelope. A failed spawn keeps it for the retry.
 */
export function consumeBackendStartReason(): DesktopBackendStartReason | null {
  const reason = pendingStartReason;
  pendingStartReason = null;
  return reason;
}
