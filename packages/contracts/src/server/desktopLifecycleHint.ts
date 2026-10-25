import { Schema } from "effect";

import { NonNegativeInt } from "../core/baseSchemas";

/**
 * Child file descriptor of the main-to-server lifecycle hint pipe. Electron main opens it at
 * backend spawn (`stdio[5] = "pipe"`) and keeps it open for the backend's lifetime. Only
 * Electron main holds the write end, so a renderer cannot forge a hint.
 */
export const DESKTOP_LIFECYCLE_HINT_FD = 5;

/**
 * The fd 3 bootstrap envelope's optional `lifecycleHintFd`. Electron main sends it, set to
 * `DESKTOP_LIFECYCLE_HINT_FD`, when it opened the hint pipe at spawn. The server reads a hint
 * pipe only when the envelope announces one: an unannounced fd 5 may be one of Node's or
 * libuv's own descriptors. An older desktop never sends it, so its backend gets no hints and
 * relies on the other sleep sources.
 */
export const DesktopLifecycleHintFd = NonNegativeInt;
export type DesktopLifecycleHintFd = typeof DesktopLifecycleHintFd.Type;

/**
 * Power and network hints Electron main forwards to the server. `resume` is the anchor of a
 * sleep epoch; `suspend` is a hint only, because Electron may miss it on every OS.
 */
export const DesktopLifecycleHintKind = Schema.Literals(["suspend", "resume", "online", "offline"]);
export type DesktopLifecycleHintKind = typeof DesktopLifecycleHintKind.Type;

/**
 * One newline-terminated JSON line on the hint pipe:
 * `{"kind":"resume","sequence":7,"occurredAt":1761140000000,"online":true}\n`.
 *
 * - `sequence` increases per written line within one backend lifetime; the server drops
 *   duplicates and out-of-order lines.
 * - `occurredAt` is Electron main's wall clock in epoch milliseconds.
 * - `online` is the latest main-process `net.isOnline()` result, or null before the first poll.
 *
 * On Linux, the `suspend` line is written synchronously (`fs.writeSync`) inside the handler,
 * because logind releases its delay lock when the handler returns.
 */
export const DesktopLifecycleHint = Schema.Struct({
  kind: DesktopLifecycleHintKind,
  sequence: NonNegativeInt,
  occurredAt: Schema.Number,
  online: Schema.NullOr(Schema.Boolean),
});
export type DesktopLifecycleHint = typeof DesktopLifecycleHint.Type;

/**
 * Why Electron main started this backend, sent as the optional `startReason` of the fd 3
 * bootstrap envelope. Absent on ordinary starts and restarts, which keep today's behavior.
 *
 * - `resume-probe-restart`: `restartUnresponsiveBackend` restarted a backend that refused
 *   connections after wake. Unsettled turns whose provider call may have been sent become
 *   "outcome unknown" prompts instead of being settled as stopped.
 */
export const DesktopBackendStartReason = Schema.Literals(["resume-probe-restart"]);
export type DesktopBackendStartReason = typeof DesktopBackendStartReason.Type;
