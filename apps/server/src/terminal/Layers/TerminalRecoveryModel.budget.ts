import { TERMINAL_RECOVERY_ANSI_MAX_CHARS } from "@bigbud/contracts/workspace/terminal.recovery.ts";

// Admission estimates, not allocator guarantees. Independent of the renderer's 5000 rows.
export const RECOVERY_SCROLLBACK_ROWS = 1000;
export const RECOVERY_PENDING_BYTES = 2 * 1024 * 1024;
export const RECOVERY_SNAPSHOT_BYTES = TERMINAL_RECOVERY_ANSI_MAX_CHARS * 2;
const SESSION_BYTES = 96 * 1024 * 1024;
const TOTAL_BYTES = 256 * 1024 * 1024;
let reserved = 0;

/** A reservation covers both buffers and headroom for parser/line metadata; never evict a PTY. */
export function reserveRecoveryModel(cols: number, rows: number): (() => void) | null {
  if (
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols < 2 ||
    cols > 1000 ||
    rows < 1 ||
    rows > 500
  )
    return null;
  const bytes = cols * (RECOVERY_SCROLLBACK_ROWS + rows * 2) * 64 + 32 * 1024 * 1024;
  if (bytes > SESSION_BYTES || reserved + bytes > TOTAL_BYTES) return null;
  reserved += bytes;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    reserved -= bytes;
  };
}
