// Account retained UTF-16 storage as well as encoded payload: <=3 bytes per code unit.
// Shared by hydration and live/in-flight parser queues, not an end-to-end transport claim.
let reserved = 0;
const limit = 8 * 1024 * 1024;

export function reserveTerminalOutput(bytes: number): boolean {
  if (reserved + bytes > limit) return false;
  reserved += bytes;
  return true;
}

export function releaseTerminalOutput(bytes: number): void {
  reserved -= bytes;
}
