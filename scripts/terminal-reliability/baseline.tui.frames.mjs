// Synthetic opencode-like TUI frames: DEC 2026 synchronized output, truecolor cells, no user data.
export const TUI_COLS = 200;
export const TUI_ROWS = 50;
const BSU = "\x1b[?2026h";
const ESU = "\x1b[?2026l";

function color(frame, row, column) {
  const shade = (frame * 3 + row * 5 + column) % 48;
  return `${24 + shade};${26 + shade};${40 + shade}`;
}

function paintRow(frame, row) {
  let line = `\x1b[${row + 1};1H`;
  for (let column = 0; column < TUI_COLS; column += 20) {
    line += `\x1b[48;2;${color(frame, row, column)}m\x1b[38;2;202;211;245m`;
    line += `cell ${String(frame % 1000).padStart(3, "0")}:${String(row).padStart(2, "0")}`.padEnd(
      20,
    );
  }
  return `${line}\x1b[0m`;
}

/** `full` repaints every row; `diff` repaints a few rows like an incremental TUI redraw. */
export function buildFrame(profile, frame) {
  let body = "";
  if (profile === "full") {
    for (let row = 0; row < TUI_ROWS; row++) body += paintRow(frame, row);
  } else {
    const rows = [TUI_ROWS - 3, TUI_ROWS - 2, frame % (TUI_ROWS - 4)];
    for (const row of rows) body += paintRow(frame, row);
  }
  return `${BSU}\x1b[?25l${body}\x1b[${TUI_ROWS - 2};4H\x1b[?25h${ESU}`;
}

/** Split like macOS PTY reads (<=1024 bytes); never split a surrogate pair. */
export function splitIntoReads(data, size = 1024) {
  const reads = [];
  for (let start = 0; start < data.length; ) {
    let end = Math.min(start + size, data.length);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
    reads.push(data.slice(start, end));
    start = end;
  }
  return reads;
}
