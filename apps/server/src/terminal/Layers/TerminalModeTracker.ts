import type { TerminalLiveModes } from "@bigbud/contracts/workspace/terminal.ts";
import { TerminalControlScanner } from "./TerminalControlScanner";

const mode = (value: number, on: boolean) => `\x1b[?${value}${on ? "h" : "l"}`;

/**
 * Mirrors the renderer's input-affecting modes from process output, independently of history
 * retention. A view that attaches without a baseline re-asserts these before going live, so
 * mouse, paste, cursor-key and alternate-screen state match the running program.
 */
export class TerminalModeTracker {
  private readonly scanner = new TerminalControlScanner({
    csi: (body, final, overflow) => {
      if (!overflow) this.apply(body, final);
    },
    esc: (final) => {
      if (final === 0x3d) this.applicationKeypad = true;
      else if (final === 0x3e) this.applicationKeypad = false;
      else if (final === 0x63) this.reset(true);
    },
  });
  private applicationCursor = false;
  private wraparound = true;
  private cursorVisible = true;
  private applicationKeypad = false;
  private mouse = 0;
  private encoding = 0;
  private focus = false;
  private bracketedPaste = false;
  private colorSchemeUpdates = false;
  private alternateScreen = false;
  private cursorStyle = 0;

  receive(data: string): void {
    this.scanner.receive(data);
  }

  private apply(body: string, final: number): void {
    if ((final === 0x68 || final === 0x6c) && body.startsWith("?")) {
      for (const param of body.slice(1).split(";")) this.setPrivate(Number(param), final === 0x68);
    } else if (final === 0x71 && body.endsWith(" ")) {
      const style = Number(body.slice(0, -1) || "0");
      this.cursorStyle = Number.isInteger(style) && style >= 0 && style <= 6 ? style : 0;
    } else if (final === 0x70 && body === "!") this.reset(false);
  }

  private setPrivate(mode: number, on: boolean): void {
    if (mode === 1) this.applicationCursor = on;
    else if (mode === 7) this.wraparound = on;
    else if (mode === 25) this.cursorVisible = on;
    else if (mode === 66) this.applicationKeypad = on;
    else if (mode === 9 || mode === 1000 || mode === 1002 || mode === 1003)
      this.mouse = on ? mode : 0;
    else if (mode === 1004) this.focus = on;
    else if (mode === 1006 || mode === 1016) this.encoding = on ? mode : 0;
    else if (mode === 2004) this.bracketedPaste = on;
    else if (mode === 2031) this.colorSchemeUpdates = on;
    else if (mode === 47 || mode === 1047 || mode === 1049) this.alternateScreen = on;
  }

  /** RIS clears everything; DECSTR keeps mouse and screen state, matching the pinned xterm. */
  private reset(full: boolean): void {
    this.applicationCursor = false;
    this.wraparound = true;
    this.cursorVisible = true;
    this.applicationKeypad = false;
    this.focus = false;
    this.bracketedPaste = false;
    this.colorSchemeUpdates = false;
    this.cursorStyle = 0;
    if (!full) return;
    this.mouse = 0;
    this.encoding = 0;
    this.alternateScreen = false;
  }

  /** Mouse and encoding resets come first: xterm resets either family from any of its modes. */
  snapshot(): TerminalLiveModes {
    let sequence =
      mode(1, this.applicationCursor) +
      mode(7, this.wraparound) +
      mode(25, this.cursorVisible) +
      mode(66, this.applicationKeypad) +
      mode(1000, false) +
      (this.mouse ? mode(this.mouse, true) : "") +
      mode(1006, false) +
      (this.encoding ? mode(this.encoding, true) : "") +
      mode(1004, this.focus) +
      mode(2004, this.bracketedPaste) +
      mode(2031, this.colorSchemeUpdates) +
      `\x1b[${this.cursorStyle} q`;
    // Re-open a sequence split by the snapshot cut, so its live tail is not printed as text.
    const state = this.scanner.state;
    const control = this.scanner.partialControl;
    if (state === "csi" && control !== null) sequence += `\x1b[${control}`;
    else if (state === "escape") sequence += "\x1b";
    else if (state === "string") sequence += "\x1b]";
    else if (state === "stringEscape") sequence += "\x1b]\x1b";
    return { sequence, alternateScreen: this.alternateScreen };
  }
}
