/** Saved history does not lock a checkout; only current or unconfirmed execution does. */
export function isThreadWorkspaceLocked(
  thread:
    | {
        session?: { status: string; orchestrationStatus?: string } | null;
        latestTurn?: { state: string } | null;
        turnStartRequest?: { outcome: string } | null | undefined;
        queuedPrompts?: readonly unknown[];
        pendingTurnControlOperation?: object | null;
        deletingAt?: string | null;
      }
    | undefined,
): boolean {
  if (!thread) return false;
  const status = thread.session?.orchestrationStatus ?? thread.session?.status;
  return Boolean(
    (status && !["closed", "stopped", "error"].includes(status)) ||
    thread.latestTurn?.state === "running" ||
    thread.turnStartRequest?.outcome === "pending" ||
    thread.queuedPrompts?.length ||
    thread.pendingTurnControlOperation ||
    thread.deletingAt,
  );
}
