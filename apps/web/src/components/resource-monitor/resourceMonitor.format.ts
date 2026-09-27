export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = value;
  let index = 0;
  while (Math.abs(amount) >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatPercent(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? "—"
    : `${value.toFixed(1)}%`;
}

export function formatTemperature(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? "—"
    : `${value.toFixed(1)} °C`;
}

export function formatRate(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? "—"
    : `${formatBytes(value)}/s`;
}
