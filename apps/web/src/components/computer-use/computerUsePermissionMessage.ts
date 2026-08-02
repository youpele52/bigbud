const LEADING_DRIVER_STATUS_MARKER = /^(?:✅|❌|ℹ️)\s*/u;
const DRIVER_STATUS_BOUNDARY = /(?:\r?\n)+|(?=✅|❌|ℹ️)/u;

export function normalizeComputerUsePermissionMessage(message: string): string {
  return message
    .split(DRIVER_STATUS_BOUNDARY)
    .map((entry) => entry.trim().replace(LEADING_DRIVER_STATUS_MARKER, "").trim())
    .filter(Boolean)
    .join("\n");
}
