/**
 * Plain text from raw terminal output, for search and parsing (not for rendering).
 *
 * Removes escape sequences: CSI (`ESC [`, also 8-bit `0x9b`), OSC (`ESC ]`, ended by BEL or ST),
 * DCS/SOS/PM/APC strings, and two-byte escapes such as charset selection (`ESC ( B`).
 */
const ESCAPE_SEQUENCES = new RegExp(
  [
    "(?:\\x1b\\[|\\x9b)[0-?]*[ -/]*[@-~]", // CSI
    "\\x1b\\][\\s\\S]*?(?:\\x07|\\x1b\\\\)", // OSC
    "\\x1b[PX^_][\\s\\S]*?\\x1b\\\\", // DCS, SOS, PM, APC
    "\\x1b[ -/]*[0-~]", // two-byte escapes
    "\\x1b", // a lone or truncated escape
  ].join("|"),
  "g",
);
// C0 controls other than \t \n \b \r, and DEL.
// eslint-disable-next-line no-control-regex
const OTHER_CONTROLS = /[\x00-\x07\x0b-\x0c\x0e-\x1f\x7f]/g;

export function stripTerminalControlSequences(text: string): string {
  return text.replace(ESCAPE_SEQUENCES, "").replace(OTHER_CONTROLS, "");
}

/**
 * One line as displayed: `\r` returns to column 0 and later characters overwrite (progress bars,
 * spinners), `\b` moves back one column. Cursor movement by escape sequences is not modelled.
 */
function resolveLine(raw: string): string {
  if (!raw.includes("\r") && !raw.includes("\b")) return raw;
  const cells: string[] = [];
  let column = 0;
  for (const char of raw) {
    if (char === "\r") column = 0;
    else if (char === "\b") column = Math.max(0, column - 1);
    else cells[column++] = char;
  }
  return cells.join("").trimEnd();
}

/** Displayed lines of raw terminal output, oldest first. */
export function terminalOutputLines(output: string): string[] {
  const plain = stripTerminalControlSequences(output);
  // A trailing CR before LF (CRLF) must not erase the line it ends.
  return plain
    .split("\n")
    .map((line) => resolveLine(line.endsWith("\r") ? line.slice(0, -1) : line));
}
