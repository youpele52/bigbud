export function nextTerminalTimestamp(previous: string): string {
  return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
}
