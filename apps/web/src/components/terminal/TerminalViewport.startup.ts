import type { TerminalEvictTarget } from "@bigbud/contracts/workspace/terminal.limit.ts";
import {
  promptTerminalLimit,
  type TerminalLimitDecision,
  type TerminalLimitPromptInput,
} from "./terminalLimitPrompt";

/** A refused open at the host's live limit, as decoded from the RPC failure. */
export function readTerminalLimitError(error: unknown): TerminalLimitPromptInput | null {
  for (let current = error, depth = 0; depth < 3; depth++) {
    if (typeof current !== "object" || current === null) return null;
    const value = current as {
      _tag?: unknown;
      limit?: unknown;
      liveCount?: unknown;
      candidate?: TerminalLimitPromptInput["candidate"] | undefined;
      cause?: unknown;
    };
    if (
      value._tag === "TerminalLimitError" &&
      typeof value.limit === "number" &&
      typeof value.liveCount === "number"
    )
      return { limit: value.limit, liveCount: value.liveCount, candidate: value.candidate ?? null };
    current = value.cause;
  }
  return null;
}

/**
 * Fence both successful and failed startup requests after lifecycle recovery supersedes them.
 * A spawn refused at the live limit asks the user (plan §11.3): "evict" retries the open with the
 * named candidate, "cancel" removes the new pane. Attach-only opens never spawn, so never ask.
 */
export function makeTerminalStartupRecovery(input: {
  open: (
    superseded: () => boolean,
    attachOnly: boolean,
    evict?: TerminalEvictTarget,
  ) => Promise<boolean>;
  onFailure: (error: unknown) => void;
  /** The user declined closing the oldest terminal; the pane that asked is removed. */
  onLimitCancelled?: () => void;
  prompt?: (input: TerminalLimitPromptInput) => Promise<TerminalLimitDecision>;
}) {
  let epoch = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const invalidate = () => {
    epoch++;
    clearTimeout(timer);
    timer = undefined;
  };
  const run = async (attachOnly = false, evict?: TerminalEvictTarget): Promise<void> => {
    invalidate();
    const requestEpoch = epoch;
    const superseded = () => requestEpoch !== epoch;
    try {
      const opened = await input.open(superseded, attachOnly, evict);
      if (!opened && !superseded()) {
        timer = setTimeout(() => void run(attachOnly, evict), 50);
      }
    } catch (error) {
      if (superseded()) return;
      const limit = attachOnly ? null : readTerminalLimitError(error);
      if (!limit) {
        input.onFailure(error);
        return;
      }
      const decision = await (input.prompt ?? promptTerminalLimit)(limit);
      if (superseded()) return;
      if (decision === "evict" && limit.candidate) {
        const { threadId, terminalId } = limit.candidate;
        // A second refusal (the candidate changed) asks again with the fresh candidate.
        await run(false, { threadId, terminalId });
        return;
      }
      input.onFailure(error);
      input.onLimitCancelled?.();
    }
  };
  return { run, invalidate };
}
