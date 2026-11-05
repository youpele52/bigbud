// ESC plus the C1 introducers xterm parses (DCS, SOS, CSI, OSC, PM, APC).
// oxlint-disable-next-line no-control-regex -- Matching control introducers is the purpose.
const INTRODUCER = /[\u001b\u0090\u0098\u009b\u009d-\u009f]/g;

export type TerminalControlScannerState =
  | "ground"
  | "escape"
  | "escapeIntermediate"
  | "csi"
  | "string"
  | "stringEscape";

export interface TerminalControlHandler {
  /** Ground-state text between control introducers, C0 controls included. */
  text?(data: string, start: number, end: number): void;
  /** A dispatched CSI. `overflow` means the body exceeded the scanner's cap and was cut. */
  csi?(body: string, final: number, overflow: boolean): void;
  /** A dispatched ESC sequence without intermediates. */
  esc?(final: number): void;
}

/**
 * Follows xterm's control-sequence transitions over process output, chunk by chunk. Plain text
 * is skipped with one regex jump per introducer, so ASCII output costs a single scan.
 */
export class TerminalControlScanner {
  private parser: TerminalControlScannerState = "ground";
  private body = "";
  private bodyOverflow = false;

  constructor(
    private readonly handler: TerminalControlHandler,
    private readonly maxBodyChars = 64,
  ) {}

  get state(): TerminalControlScannerState {
    return this.parser;
  }

  /** The partial CSI body, or null once it overflowed the cap. */
  get partialControl(): string | null {
    return this.bodyOverflow ? null : this.body;
  }

  receive(data: string): void {
    let index = 0;
    while (index < data.length) {
      if (this.parser === "ground") {
        INTRODUCER.lastIndex = index;
        const match = INTRODUCER.exec(data);
        const end = match ? match.index : data.length;
        if (end > index) this.handler.text?.(data, index, end);
        if (!match) return;
        index = end;
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
        this.parser = "ground";
        this.handler.csi?.(this.body, code, this.bodyOverflow);
      } else if (this.body.length < this.maxBodyChars) this.body += String.fromCharCode(code);
      else this.bodyOverflow = true;
    } else if (this.parser === "escapeIntermediate") {
      if (code >= 0x30) this.parser = "ground";
    } else if (this.parser === "escape") {
      if (code === 0x5b) this.beginControl();
      else if (code === 0x5d || code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f)
        this.parser = "string";
      else if (code >= 0x20 && code <= 0x2f) this.parser = "escapeIntermediate";
      else if (code >= 0x30) {
        this.parser = "ground";
        this.handler.esc?.(code);
      }
    }
  }

  private beginControl(): void {
    this.parser = "csi";
    this.body = "";
    this.bodyOverflow = false;
  }
}
