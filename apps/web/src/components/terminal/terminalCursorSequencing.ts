// Ported from Orca (stablyai/orca, MIT) pane-terminal-cursor-sequencing.ts at be4e0719. Applied to
// visible output on native Windows terminals only, matching Orca's ConPTY gating.

const CURSOR_SHOW_SEQUENCE = "\x1b[?25h";
const CURSOR_HIDE_SEQUENCE = "\x1b[?25l";
const SYNCHRONIZED_OUTPUT_END_SEQUENCE = "\x1b[?2026l";

function findCursorPositionSequenceEnd(
  data: string,
  fromIndex: number,
  toIndex = data.length,
): number {
  let offset = data.indexOf("\x1b[", fromIndex);
  while (offset !== -1 && offset < toIndex) {
    let index = offset + 2;
    while (index < toIndex) {
      const char = data[index]!;
      if (char === "G" || char === "H" || char === "f") {
        return index + 1;
      }
      if ((char < "0" || char > "9") && char !== ";") {
        break;
      }
      index += 1;
    }
    offset = data.indexOf("\x1b[", offset + 2);
  }
  return -1;
}

export function removeTransientCursorShowSequences(data: string): string {
  let result = "";
  let offset = 0;
  let showIndex = data.indexOf(CURSOR_SHOW_SEQUENCE);
  while (showIndex !== -1) {
    const nextHideIndex = data.indexOf(
      CURSOR_HIDE_SEQUENCE,
      showIndex + CURSOR_SHOW_SEQUENCE.length,
    );
    const nextPositionEnd = findCursorPositionSequenceEnd(
      data,
      showIndex + CURSOR_SHOW_SEQUENCE.length,
      nextHideIndex === -1 ? data.length : nextHideIndex,
    );
    if (nextHideIndex === -1) {
      if (nextPositionEnd === -1) {
        const synchronizedEndIndex = data.indexOf(
          SYNCHRONIZED_OUTPUT_END_SEQUENCE,
          showIndex + CURSOR_SHOW_SEQUENCE.length,
        );
        if (synchronizedEndIndex === -1) {
          break;
        }
        // Why: keep the cursor hidden through the synchronized repaint, restoring it after the frame ends so Windows never paints it in the transient draw position.
        result += data.slice(offset, showIndex);
        result += data.slice(
          showIndex + CURSOR_SHOW_SEQUENCE.length,
          synchronizedEndIndex + SYNCHRONIZED_OUTPUT_END_SEQUENCE.length,
        );
        result += CURSOR_SHOW_SEQUENCE;
        offset = synchronizedEndIndex + SYNCHRONIZED_OUTPUT_END_SEQUENCE.length;
        showIndex = data.indexOf(CURSOR_SHOW_SEQUENCE, offset);
        continue;
      }
      // Why: Codex can show the cursor before its final synchronized-frame placement. Place first so xterm cannot rasterize the stale cell.
      result += data.slice(offset, showIndex);
      result += data.slice(showIndex + CURSOR_SHOW_SEQUENCE.length, nextPositionEnd);
      result += CURSOR_SHOW_SEQUENCE;
      offset = nextPositionEnd;
      showIndex = data.indexOf(CURSOR_SHOW_SEQUENCE, offset);
      continue;
    }
    result += data.slice(offset, showIndex);
    offset = showIndex + CURSOR_SHOW_SEQUENCE.length;
    showIndex = data.indexOf(CURSOR_SHOW_SEQUENCE, offset);
  }
  return offset === 0 ? data : result + data.slice(offset);
}
