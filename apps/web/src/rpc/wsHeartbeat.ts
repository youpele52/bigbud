export const WS_HEARTBEAT_INTERVAL_MS = 5_000;
export const WS_HEARTBEAT_TIMEOUT_MS = 15_000;
export const WS_HEARTBEAT_FAILURE_THRESHOLD = 3;

export function shouldReconnectAfterHeartbeatFailure(consecutiveFailures: number): boolean {
  return consecutiveFailures >= WS_HEARTBEAT_FAILURE_THRESHOLD;
}

export async function runWsHeartbeatProbe(
  ping: () => Promise<unknown>,
  timeoutMs = WS_HEARTBEAT_TIMEOUT_MS,
): Promise<boolean> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      ping(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("WebSocket heartbeat timed out.")),
          timeoutMs,
        );
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}
