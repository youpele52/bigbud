import type { RuntimeMode } from "./config.ts";

/**
 * Rotation for the local trace file (`logs/server.trace.ndjson`). Server logs themselves go
 * to stdout/stderr; under the remote profile that is the systemd journal, which journald
 * rotates. The trace file is the only log file the backend writes in production.
 */
export const DEFAULT_TRACE_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_TRACE_MAX_FILES = 10;

/**
 * Remote backends run on small VPS disks next to the user's projects. Keep the trace file to
 * at most (1 + 4) x 8 MiB = 40 MiB instead of the desktop's 110 MiB. Explicit
 * `BIGBUD_TRACE_MAX_BYTES` / `BIGBUD_TRACE_MAX_FILES` values still win.
 */
export const REMOTE_TRACE_MAX_BYTES = 8 * 1024 * 1024;
export const REMOTE_TRACE_MAX_FILES = 4;

export interface TraceRotation {
  readonly traceMaxBytes: number;
  readonly traceMaxFiles: number;
}

export function resolveTraceRotation(
  mode: RuntimeMode,
  explicit: { readonly maxBytes: number | undefined; readonly maxFiles: number | undefined },
): TraceRotation {
  const remote = mode === "remote";
  return {
    traceMaxBytes: explicit.maxBytes ?? (remote ? REMOTE_TRACE_MAX_BYTES : DEFAULT_TRACE_MAX_BYTES),
    traceMaxFiles: explicit.maxFiles ?? (remote ? REMOTE_TRACE_MAX_FILES : DEFAULT_TRACE_MAX_FILES),
  };
}
