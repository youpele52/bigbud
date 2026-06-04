import { type Terminal } from "@xterm/xterm";

export class TerminalWriteBatcher {
  private pending = "";
  private terminal: Terminal | null = null;
  private isWriting = false;
  private isDisposed = false;

  write(terminal: Terminal, data: string): void {
    if (this.isDisposed) {
      return;
    }
    this.terminal = terminal;
    this.pending += data;
    if (this.isWriting) {
      return;
    }
    this.flushPending();
  }

  flush(): void {
    if (this.pending.length === 0 || !this.terminal) {
      this.pending = "";
      this.terminal = null;
      return;
    }
    const pending = this.pending;
    const terminal = this.terminal;
    this.pending = "";
    terminal.write(pending);
  }

  private flushPending(): void {
    if (this.isDisposed || this.isWriting || this.pending.length === 0 || !this.terminal) {
      return;
    }
    const pending = this.pending;
    const terminal = this.terminal;
    this.pending = "";
    this.isWriting = true;
    terminal.write(pending, () => {
      this.isWriting = false;
      if (this.isDisposed) {
        this.pending = "";
        this.terminal = null;
        return;
      }
      this.flushPending();
    });
  }

  dispose(): void {
    this.isDisposed = true;
    this.pending = "";
    this.terminal = null;
  }
}
