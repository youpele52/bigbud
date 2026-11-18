/**
 * P8 worker peer endpoint constants (M6 WP-8B/8C).
 *
 * The worker's peer socket serves exactly these four POST routes. The SSH forced-command helper
 * sets the credential headers from its fixed argv (bound to one authorized key) and strips any the
 * coordinator sent, so the coordinator never names its own grant or key.
 */
export const PEER_ROUTE_PATHS = {
  delegate: "/api/peer/v1/delegate",
  status: "/api/peer/v1/status",
  follow: "/api/peer/v1/follow",
  cancel: "/api/peer/v1/cancel",
} as const;

export const PEER_CREDENTIAL_HEADERS = {
  grant: "x-bigbud-peer-grant",
  coordinator: "x-bigbud-peer-coordinator",
  keyFingerprint: "x-bigbud-peer-key",
} as const;

/** Request bodies are small JSON; a delegate task is at most 32000 characters. */
export const PEER_REQUEST_MAX_BYTES = 192 * 1024;
/** One follow request waits at most this long before replying with the current status. */
export const PEER_FOLLOW_MAX_WAIT_MS = 25_000;

/** Owner-only grant administration over the authenticated client socket (`bigbud peer`). */
export const PEER_GRANT_OWNER_PATH = "/api/remote-backend/peer-grants";
export const PEER_GRANT_OWNER_MAX_BYTES = 32 * 1024;
