const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

/** Binary-unit byte size with two decimals (`1.50 MiB`); `—` when the value is unknown. */
export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  let amount = value;
  let index = 0;
  while (Math.abs(amount) >= 1024 && index < BYTE_UNITS.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(2)} ${BYTE_UNITS[index]}`;
}
