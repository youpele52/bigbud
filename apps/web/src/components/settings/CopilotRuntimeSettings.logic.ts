export function formatBytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}
