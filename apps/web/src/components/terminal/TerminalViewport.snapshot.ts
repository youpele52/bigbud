import type { TerminalSessionSnapshot } from "@bigbud/contracts/workspace/terminal.ts";
import { isCurrentTerminalSnapshot, readTerminalLaunch } from "../../lib/terminalLaunchBinding";
import { withTerminalViewDeadline } from "./terminalLifecycle.operations";

export function hasCurrentTerminalBaseline(
  snapshot: TerminalSessionSnapshot,
  localUpdatedAt: string | null,
): boolean {
  const globalUpdatedAt = readTerminalLaunch(snapshot.threadId, snapshot.terminalId)?.updatedAt;
  return Boolean(localUpdatedAt && globalUpdatedAt && localUpdatedAt >= globalUpdatedAt);
}

/** Newer global metadata does not imply this particular delivery has its history baseline. */
export async function resolveTerminalViewportSnapshot(
  snapshot: TerminalSessionSnapshot,
  input: {
    localUpdatedAt: () => string | null;
    disposed: () => boolean;
    refresh?: (() => Promise<TerminalSessionSnapshot>) | undefined;
  },
): Promise<TerminalSessionSnapshot | null> {
  if (input.disposed()) return null;
  if (isCurrentTerminalSnapshot(snapshot)) return snapshot;
  // hydrate(old) can open an already-staged newer baseline without restoring old metadata.
  if (hasCurrentTerminalBaseline(snapshot, input.localUpdatedAt())) return snapshot;
  if (!input.refresh)
    throw new Error(
      "Current terminal history is unavailable. Reload the view to reconnect without restarting the shell.",
    );
  const fresh = await withTerminalViewDeadline(input.refresh());
  if (input.disposed()) return null;
  if (
    fresh.threadId !== snapshot.threadId ||
    fresh.terminalId !== snapshot.terminalId ||
    !isCurrentTerminalSnapshot(fresh)
  )
    throw new Error(
      "Terminal changed while reconnecting. Reload the view to fetch current output; no additional shell was started.",
    );
  return fresh;
}
