import type { TerminalLiveModes } from "@bigbud/contracts/workspace/terminal.ts";

const MAX_CONTROL_CHARS = 64;
// ESC plus the C1 introducers xterm parses (DCS, SOS, CSI, OSC, PM, APC).
// oxlint-disable-next-line no-control-regex -- Matching control introducers is the purpose.
const INTRODUCER = /[\u001b\u0090\u0098\u009b\u009d-\u009f]/g;
const mode = (value: number, on: boolean) => `\x1b[?${value}${on ? "h" : "l"}`;
type Parser = "ground" | "escape" | "escapeIntermediate" | "csi" | "string" | "stringEscape";

/**
 * Mirrors the renderer's input-affecting modes from process output, independently of history
 * retention. A view that attaches without a baseline re-asserts these before going live, so
 * mouse, paste, cursor-key and alternate-screen state match the running program.
 */
export class TerminalModeTracker {
  private parser: Parser = "ground";
  private control = "";
  private controlOverflow = false;
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
    let index = 0;
    while (index < data.length) {
      if (this.parser === "ground") {
        INTRODUCER.lastIndex = index;
        const match = INTRODUCER.exec(data);
        if (!match) return;
        index = match.index;
      }
      this.step(data.charCodeAt(index));
      index++;
    }
  }

  private step(code: number): void {
    if (code === 0x18 || code === 0x1a) {
      this.parser = "ground"; // CAN/SUB abort any sequence.
      return;
    }
    if (this.parser === "string") {
      if (code === 0x1b) this.parser = "stringEscape";
      else if (code === 0x07 || code === 0x9c) this.parser = "ground";
      return;
    }
    if (this.parser === "stringEscape") {
      // ESC \ is ST; any other byte follows an ESC that opened a new sequence, as in xterm.
      this.parser = code === 0x5c ? "ground" : "escape";
      if (code === 0x5c) return;
    } else if (code === 0x1b) {
      this.parser = "escape";
      return;
    } else if (code === 0x9b) {
      this.beginControl();
      return;
    } else if (code === 0x90 || code === 0x98 || (code >= 0x9d && code <= 0x9f)) {
      this.parser = "string";
      return;
    }
    if (this.parser === "csi") {
      if (code < 0x20) return; // C0 controls execute inside CSI without ending it.
      if (code >= 0x40 && code <= 0x7e) {
        if (!this.controlOverflow) this.apply(this.control, code);
        this.parser = "ground";
      } else if (this.control.length < MAX_CONTROL_CHARS) this.control += String.fromCharCode(code);
      else this.controlOverflow = true;
    } else if (this.parser === "escapeIntermediate") {
      if (code >= 0x30) this.parser = "ground";
    } else if (this.parser === "escape") {
      if (code === 0x5b) this.beginControl();
      else if (code === 0x5d || code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f)
        this.parser = "string";
      else if (code >= 0x20 && code <= 0x2f) this.parser = "escapeIntermediate";
      else if (code >= 0x30) {
        if (code === 0x3d) this.applicationKeypad = true;
        else if (code === 0x3e) this.applicationKeypad = false;
        else if (code === 0x63) this.reset(true);
        this.parser = "ground";
      }
    }
  }

  private beginControl(): void {
    this.parser = "csi";
    this.control = "";
    this.controlOverflow = false;
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
    if (this.parser === "csi" && !this.controlOverflow) sequence += `\x1b[${this.control}`;
    else if (this.parser === "escape") sequence += "\x1b";
    else if (this.parser === "string") sequence += "\x1b]";
    else if (this.parser === "stringEscape") sequence += "\x1b]\x1b";
    return { sequence, alternateScreen: this.alternateScreen };
  }
}
