const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";
/** Alt+Enter (newline in agent TUIs) is ESC CR, never a submission. */
const ALT_ENTER = "\u001b\r";
/** Kitty keyboard protocol Enter without modifiers. */
const KITTY_ENTER = ["\u001b[13u", "\u001b[13;1u"] as const;
const SEQUENCES = [PASTE_START, PASTE_END, ALT_ENTER, ...KITTY_ENTER] as const;

/**
 * Detects a submitted line (Enter) in client keystrokes, chunk by chunk. Pasted text inside a
 * bracketed paste never counts; an escape sequence split across writes is completed first.
 * Focus, resize and plain typing never reach this detector as Enter.
 */
export function createTerminalSubmitDetector(): (data: string) => boolean {
  let inPaste = false;
  let pending = "";
  return (data) => {
    const text = pending + data;
    pending = "";
    let submitted = false;
    let index = 0;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === 0x1b) {
        const sequence = SEQUENCES.find((candidate) => text.startsWith(candidate, index));
        if (sequence) {
          if (sequence === PASTE_START) inPaste = true;
          else if (sequence === PASTE_END) inPaste = false;
          else if (!inPaste && sequence !== ALT_ENTER) submitted = true;
          index += sequence.length;
          continue;
        }
        const rest = text.slice(index);
        if (
          SEQUENCES.some(
            (candidate) => candidate.length > rest.length && candidate.startsWith(rest),
          )
        ) {
          pending = rest;
          break;
        }
      } else if (!inPaste && (code === 0x0d || code === 0x0a)) {
        submitted = true;
      }
      index++;
    }
    return submitted;
  };
}
