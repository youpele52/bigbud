/**
 * Authenticated same-user backend drain control (W3.4). The running backend owns
 * the state lock and live panes, so the CLI sends one bounded request over an
 * owner-only Unix socket instead of doing an offline drain. The socket file is
 * mode 0600 and every request must carry the 32-byte token from the private
 * `backend-drain.token` file; there is no remote or unauthenticated path.
 *
 * @module backendDrain.protocol
 */
import {
  BACKEND_DRAIN_MAX_WAIT_MS,
  BACKEND_DRAIN_VERSION,
  type BackendDrainConsent,
} from "@bigbud/shared/backendDrain.client";

export {
  BACKEND_DRAIN_MAX_REQUEST_BYTES,
  BACKEND_DRAIN_MAX_WAIT_MS,
  BACKEND_DRAIN_VERSION,
  type BackendDrainConsent,
} from "@bigbud/shared/backendDrain.client";
export const BACKEND_DRAIN_ADMISSION_MS = 2_000;

export interface BackendDrainRequest {
  readonly v: 1;
  readonly token: string;
  readonly method: "drain";
  readonly artifactId: string;
  readonly consent: BackendDrainConsent;
  readonly waitMs: number;
}

export type BackendDrainStatus =
  | "drained"
  | "cancelled"
  | "consent-required"
  | "busy"
  | "unknown-artifact"
  | "timeout";

export type BackendDrainResponse =
  | {
      readonly v: 1;
      readonly ok: true;
      readonly status: BackendDrainStatus;
      /** Present after the stop phase ran: monitors, relays then providers, in order. */
      readonly stops?: ReadonlyArray<{
        readonly step: "monitors" | "relays" | "providers";
        readonly stopped: number;
        readonly owners: number;
      }>;
    }
  | {
      readonly v: 1;
      readonly ok: false;
      readonly error: {
        readonly code: "invalid-request" | "unauthorized" | "unavailable" | "failed";
        readonly message: string;
      };
    };

export const BACKEND_DRAIN_EXIT = {
  drained: 0,
  consentRequired: 2,
  busy: 3,
  unknownArtifact: 4,
  cancelled: 5,
  failed: 6,
  unavailable: 7,
} as const;

export function backendDrainExitCode(status: BackendDrainStatus): number {
  switch (status) {
    case "drained":
      return BACKEND_DRAIN_EXIT.drained;
    case "consent-required":
      return BACKEND_DRAIN_EXIT.consentRequired;
    case "busy":
      return BACKEND_DRAIN_EXIT.busy;
    case "unknown-artifact":
      return BACKEND_DRAIN_EXIT.unknownArtifact;
    case "cancelled":
      return BACKEND_DRAIN_EXIT.cancelled;
    case "timeout":
      return BACKEND_DRAIN_EXIT.failed;
  }
}

const TOKEN = /^[a-f0-9]{64}$/;

export function parseBackendDrainRequest(
  value: unknown,
): BackendDrainRequest | { readonly error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { error: "Request must be a JSON object." };
  const request = value as Record<string, unknown>;
  if (
    request.v !== BACKEND_DRAIN_VERSION ||
    request.method !== "drain" ||
    typeof request.token !== "string" ||
    !TOKEN.test(request.token) ||
    typeof request.artifactId !== "string" ||
    request.artifactId.length === 0 ||
    request.artifactId.length > 256 ||
    (request.consent !== "ui" && request.consent !== "non-interactive") ||
    typeof request.waitMs !== "number" ||
    !Number.isInteger(request.waitMs) ||
    request.waitMs < 0
  )
    return { error: "Request fields are invalid." };
  const keys = Object.keys(request);
  if (
    keys.some((key) => !["v", "token", "method", "artifactId", "consent", "waitMs"].includes(key))
  )
    return { error: "Request contains unsupported fields." };
  return {
    v: 1,
    token: request.token,
    method: "drain",
    artifactId: request.artifactId,
    consent: request.consent,
    waitMs: Math.min(request.waitMs, BACKEND_DRAIN_MAX_WAIT_MS),
  };
}
