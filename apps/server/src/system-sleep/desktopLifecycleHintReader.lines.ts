/**
 * Synchronous line splitting for the fd 5 hint pipe.
 *
 * The socket's data events and the synchronous SIGTERM drain feed one splitter, so bytes from
 * both paths join into whole lines in pipe order and share one UTF-8 decoder.
 *
 * @module desktopLifecycleHintReader.lines
 */
import { StringDecoder } from "node:string_decoder";

export class DesktopHintLineSplitter {
  private readonly decoder = new StringDecoder("utf8");
  private buffered = "";
  private discardingOversizedLine = false;
  private ended = false;

  /**
   * @param onLine Called once per newline-terminated line, without the newline.
   * @param maxLineChars A longer line is dropped whole and reported through `onOversized`.
   */
  constructor(
    private readonly onLine: (line: string) => void,
    private readonly maxLineChars: number,
    private readonly onOversized: (length: number) => void = () => undefined,
  ) {}

  push(chunk: Buffer | string): void {
    if (this.ended) return;
    let input = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    while (input.length > 0) {
      const newline = input.indexOf("\n");
      if (this.discardingOversizedLine) {
        if (newline < 0) return;
        this.discardingOversizedLine = false;
        input = input.slice(newline + 1);
        continue;
      }
      const fragmentLength = newline < 0 ? input.length : newline;
      if (this.buffered.length + fragmentLength > this.maxLineChars) {
        this.onOversized(this.buffered.length + fragmentLength);
        this.buffered = "";
        if (newline < 0) {
          this.discardingOversizedLine = true;
          return;
        }
        input = input.slice(newline + 1);
        continue;
      }
      this.buffered += input.slice(0, fragmentLength);
      if (newline < 0) return;
      const line = this.buffered;
      this.buffered = "";
      input = input.slice(newline + 1);
      this.onLine(line);
    }
  }

  /** Delivers a final line that had no newline, as `readline` does when its input ends. */
  end(): void {
    if (this.ended) return;
    const rest = this.buffered + this.decoder.end();
    this.ended = true;
    this.buffered = "";
    if (!this.discardingOversizedLine && rest.length > 0) this.onLine(rest);
  }
}
