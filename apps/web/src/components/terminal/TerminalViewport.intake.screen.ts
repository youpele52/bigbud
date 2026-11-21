import type { TerminalScreenItem } from "@bigbud/contracts/workspace/terminal.stream.ts";
import type { Terminal } from "@xterm/xterm";
import type { TerminalWriteBatcher } from "./TerminalWriteBatcher";
import { ownRecoveryGeometry } from "./terminalRecoveryGeometry";

const SCREEN_CHUNK_UNITS = 8192;

function* screenChunks(text: string): Generator<string> {
  for (let offset = 0; offset < text.length; ) {
    let end = Math.min(offset + SCREEN_CHUNK_UNITS, text.length);
    const last = text.charCodeAt(end - 1);
    // Never split a surrogate pair across writes.
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    yield text.slice(offset, end);
    offset = end;
  }
}

/** Writes `text` in parse-paced chunks; resolves false as soon as `aborted()` turns true. */
export async function writeTerminalChunks(
  terminal: Terminal,
  lane: TerminalWriteBatcher,
  text: string,
  aborted: () => boolean,
): Promise<boolean> {
  for (const chunk of screenChunks(text)) {
    lane.write(terminal, chunk);
    await lane.whenIdle();
    if (aborted()) return false;
  }
  return true;
}

/** A host-backed snapshot of the generation a painted screen already covers replays nothing. */
export function isSnapshotCoveredByScreen(
  screenGeneration: string | null,
  snapshot: {
    readonly screenSource?: string | undefined;
    readonly runtimeGeneration?: string | undefined;
  },
): boolean {
  return (
    screenGeneration !== null &&
    snapshot.screenSource === "host" &&
    snapshot.runtimeGeneration === screenGeneration
  );
}

/** How a replayed history baseline restores the screen: fully, or as a line-cut tail. */
export function historyFidelity(snapshot: { readonly historyTrimmed?: boolean | undefined }) {
  return snapshot.historyTrimmed ? ("trimmed" as const) : ("ready" as const);
}

export function terminalScreenTrace(screen: TerminalScreenItem) {
  return {
    type: "screen" as const,
    cols: screen.cols,
    rows: screen.rows,
    ansiChars: screen.ansi.length,
    fidelity: screen.fidelity,
    cold: screen.cold,
  };
}

/**
 * Paints the host's screen copy (plan §15 W2, N7): reset, resize xterm to the snapshot's grid,
 * then write the ANSI and the pending escape tail. The caller holds input closed, so replies to
 * queries inside the snapshot are suppressed; it releases queued live output and fits afterwards.
 * Fit is deferred while the screen is written so the ANSI is never laid out on another grid.
 * Resolves false when disposed or superseded part-way.
 */
export async function writeTerminalScreen(input: {
  readonly terminal: Terminal;
  readonly lane: TerminalWriteBatcher;
  readonly screen: TerminalScreenItem;
  readonly aborted: () => boolean;
}): Promise<boolean> {
  const { terminal, lane, screen } = input;
  const releaseGeometry = ownRecoveryGeometry(terminal);
  try {
    lane.write(terminal, "\x1bc");
    lane.barrier(() => {
      if (terminal.cols !== screen.cols || terminal.rows !== screen.rows)
        terminal.resize(screen.cols, screen.rows);
    });
    for (const text of [screen.ansi, screen.pendingEscapeTail])
      if (!(await writeTerminalChunks(terminal, lane, text, input.aborted))) return false;
    await lane.whenIdle();
    return !input.aborted();
  } finally {
    releaseGeometry();
  }
}
