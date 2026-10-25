/** Reason a renderer attaches to its first connect after a navigation or reload. */
export const WS_CONNECTION_DIAGNOSTICS_PAGE_LOAD_REASON = "page-load";

/** Longest close reason, report reason, or error detail the server accepts in one report. */
export const WS_CONNECTION_DIAGNOSTICS_TEXT_MAX_LENGTH = 512;
export const WS_CONNECTION_DIAGNOSTICS_CONSUMER_ID_MAX_LENGTH = 256;

/** Default and maximum number of ring entries returned by one diagnostics read. */
export const WS_CONNECTION_DIAGNOSTICS_READ_DEFAULT_LIMIT = 20;
export const WS_CONNECTION_DIAGNOSTICS_READ_MAX_LIMIT = 200;

/** A single event-loop stall at or above this duration is published as `stalled`. */
export const SERVER_STALL_THRESHOLD_MS = 1_000;

/** Upper bound on the spans attached to one stall for attribution. */
export const SERVER_STALL_MAX_SPANS = 8;
