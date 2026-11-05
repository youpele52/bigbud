const C1_STRING_KINDS: Readonly<Record<string, string>> = {
  "\u009d": "]",
  "\u0090": "P",
  "\u009e": "^",
  "\u009f": "_",
  "\u0098": "X",
};

/** Stateless xterm DA replies are owned at live ingress, never reconstructed from history. */
export class TerminalDeviceQueries {
  private state:
    | "ground"
    | "escape"
    | "csi"
    | "passthroughEscape"
    | "passthroughCsi"
    | "string"
    | "stringEscape" = "ground";
  private pending = "";
  private stringKind = "";

  constructor(private readonly reply: (data: string) => boolean) {}

  /** Preserve an incomplete control prefix when its process can no longer produce a tail. */
  finish(): string {
    const pending = this.pending;
    this.state = "ground";
    this.pending = "";
    this.stringKind = "";
    return pending;
  }

  receive(data: string): string {
    // Plain output is the hot path; avoid a per-codepoint copy when no parser state can change.
    if (
      this.state === "ground" &&
      !data.includes("\u001b") &&
      !/[\u0090\u0098\u009b\u009d-\u009f]/.test(data)
    )
      return data;
    let output = "";
    for (const char of data) {
      if (this.state === "string" || this.state === "stringEscape") {
        output += char;
        if (
          char === "\u009c" ||
          char === "\u0018" ||
          char === "\u001a" ||
          (char === "\u0007" && this.stringKind === "]") ||
          (this.state === "stringEscape" && char === "\\")
        )
          this.state = "ground";
        else this.state = char === "\u001b" ? "stringEscape" : "string";
        continue;
      }
      const code = char.charCodeAt(0);
      const stringKind = C1_STRING_KINDS[char];
      if (char === "\u001b" || char === "\u009b" || stringKind) {
        // An introducer cancels unfinished syntax, not the C0 effects already emitted.
        // Overflow syntax was forwarded; cancel that renderer state before hiding a new query.
        if (this.state === "passthroughEscape" || this.state === "passthroughCsi")
          output += "\u0018";
        this.pending = stringKind ? "" : char;
        this.state = stringKind ? "string" : char === "\u001b" ? "escape" : "csi";
        if (stringKind) {
          this.stringKind = stringKind;
          output += char;
        }
        continue;
      }
      if (this.state === "escape" || this.state === "csi") {
        if (char === "\u0018" || char === "\u001a") {
          output += this.pending + char;
          this.pending = "";
          this.state = "ground";
          continue;
        }
        if (code < 0x20 || code === 0x7f) {
          // Execute C0 immediately (DEL is ignored by xterm) without leaving ESC/CSI.
          // Never replay these effects if a non-query or a failed reply later flushes syntax.
          output += char;
          continue;
        }
        if (this.state === "escape") {
          if (this.pending === "\u001b" && char === "[") {
            this.pending += char;
            this.state = "csi";
            continue;
          }
          if (this.pending === "\u001b" && "]P^_X".includes(char)) {
            output += this.pending + char;
            this.pending = "";
            this.stringKind = char;
            this.state = "string";
            continue;
          }
          this.pending += char;
          if (code >= 0x20 && code <= 0x2f && this.pending.length <= 32) continue;
          output += this.pending;
          this.pending = "";
          this.state = code >= 0x20 && code <= 0x2f ? "passthroughEscape" : "ground";
          continue;
        }
        this.pending += char;
        if (code >= 0x40 && code <= 0x7e) {
          const body = this.pending.slice(this.pending.startsWith("\u001b") ? 2 : 1, -1);
          const isQuery = char === "c" && /^>?0*$/.test(body);
          const reply = body.startsWith(">") ? "\u001b[>0;276;0c" : "\u001b[?1;2c";
          if (!isQuery || !this.reply(reply)) output += this.pending;
          this.pending = "";
          this.state = "ground";
        } else if (this.pending.length > 32 || code > 0x3f) {
          output += this.pending;
          this.pending = "";
          this.state = code <= 0x3f ? "passthroughCsi" : "ground";
        }
        continue;
      }
      output += char;
      if (
        char === "\u0018" ||
        char === "\u001a" ||
        (this.state === "passthroughCsi" && code >= 0x40 && code <= 0x7e) ||
        (this.state === "passthroughEscape" && code >= 0x30 && code <= 0x7e)
      )
        this.state = "ground";
    }
    return output;
  }
}
