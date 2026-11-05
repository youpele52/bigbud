import type { DesktopBackendStartReason } from "@bigbud/contracts/server/desktopLifecycleHint.ts";

/**
 * One-use access to the supervised computer-use owner, delivered to the server only through this
 * fd 3 envelope (never env, argv or logs). The desktop applies no gate of its own: main decides
 * whether access exists at all, and every backend start must take a fresh one.
 */
export interface ComputerUseOwnerAccess {
  readonly endpoint: string;
  readonly capability: string;
  readonly tupleDigest: string;
  readonly ownerGeneration: string;
}

export interface BackendBootstrapEnvelopeInput {
  readonly port: number;
  readonly host: string;
  readonly t3Home: string;
  readonly authToken: string;
  readonly systemMonitorAgentAccess?: { readonly endpoint: string; readonly token: string } | null;
  readonly computerUseOwner?: ComputerUseOwnerAccess | null;
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
    // Exactly the four fields, so nothing else a provider attached can leak into the envelope.
    ...(input.computerUseOwner
      ? {
          computerUseOwner: {
            endpoint: input.computerUseOwner.endpoint,
            capability: input.computerUseOwner.capability,
            tupleDigest: input.computerUseOwner.tupleDigest,
            ownerGeneration: input.computerUseOwner.ownerGeneration,
          },
        }
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

/**
 * Takes this start's owner access, if main provides any. Called once per backend start, right
 * before the envelope is written, so a one-use capability is never taken for a start that cannot
 * deliver it and never reused. A failing provider means no access, never a failed backend start;
 * its error is not logged because it may describe the capability.
 */
export function takeComputerUseOwnerAccess(
  provider: (() => ComputerUseOwnerAccess | null) | undefined,
): ComputerUseOwnerAccess | null {
  if (!provider) return null;
  try {
    return provider();
  } catch {
    return null;
  }
}
