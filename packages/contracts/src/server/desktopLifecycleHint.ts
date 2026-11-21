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

/** Why Electron main is quitting: a user quit, an update install, or an app restart. */
export const DesktopQuitReason = Schema.Literals(["quit", "update", "restart"]);
export type DesktopQuitReason = typeof DesktopQuitReason.Type;

/**
 * The `quit` hint line: Electron main announces quit intent before it stops the backend, then
 * waits for a `DesktopLifecycleHintAck` with the same `sequence`. It shares the power hints'
 * sequence counter. It is a separate record so `DesktopLifecycleHint` consumers keep handling
 * only power and network kinds; readers that understand quit decode `DesktopLifecycleHintLine`.
 * An older server rejects the line, which leaves today's quit behavior.
 */
export const DesktopQuitHint = Schema.Struct({
  kind: Schema.Literal("quit"),
  sequence: NonNegativeInt,
  occurredAt: Schema.Number,
  online: Schema.NullOr(Schema.Boolean),
  reason: Schema.optional(DesktopQuitReason),
});
export type DesktopQuitHint = typeof DesktopQuitHint.Type;

/** Every line Electron main may write on the hint pipe. */
export const DesktopLifecycleHintLine = Schema.Union([DesktopLifecycleHint, DesktopQuitHint]);
export type DesktopLifecycleHintLine = typeof DesktopLifecycleHintLine.Type;

/** Server-to-main record: the server finished applying the hint with this `sequence`. */
export const DesktopLifecycleHintAck = Schema.Struct({
  sequence: NonNegativeInt,
});
export type DesktopLifecycleHintAck = typeof DesktopLifecycleHintAck.Type;

/**
 * Why Electron main started this backend, sent as the optional `startReason` of the fd 3
 * bootstrap envelope. Absent on ordinary starts and restarts, which keep today's behavior.
 *
 * - `resume-probe-restart`: `restartUnresponsiveBackend` restarted a backend that refused
 *   connections after wake. Unsettled turns whose provider call may have been sent become
 *   "outcome unknown" prompts instead of being settled as stopped.
 * - `unexpected-exit-restart`: `scheduleBackendRestart` replaced a backend that exited on its
 *   own (a crash such as heap exhaustion). The same turns become prompts, so an agent that died
 *   with the process is never a silent stop. Yields to a pending `resume-probe-restart`.
 */
export const DesktopBackendStartReason = Schema.Literals([
  "resume-probe-restart",
  "unexpected-exit-restart",
]);
export type DesktopBackendStartReason = typeof DesktopBackendStartReason.Type;
