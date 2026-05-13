import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SHELL_OUTPUT_BATCH_FLUSH_MS = 150;
export const SHELL_OUTPUT_BATCH_MAX_BYTES = 8 * 1024;
export const SHELL_RESULT_PROMOTION_RUNTIME_MS = 5_000;
export const SHELL_RESULT_PROMOTION_MAX_BYTES = 64 * 1024;
export const SHELL_RESULT_PROMOTION_MAX_LINES = 300;
export const SHELL_LIVE_TAIL_MAX_BYTES = 64 * 1024;
export const SHELL_LIVE_TAIL_MAX_LINES = 300;

type ShellOutputMode = "result" | "log";

export interface ShellOutputUpdate {
  readonly mode: ShellOutputMode;
  readonly dispatch: "append" | "replace";
  readonly text: string;
}

function countLines(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      count += 1;
    }
  }
  return count;
}

function renderShellMessage(command: string, body: string): string {
  return body.length > 0 ? `$ ${command}\n\n${body}` : `$ ${command}`;
}

function trimTail(
  text: string,
  maxLines: number,
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  const lines = text.split("\n");
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      truncated: false,
    };
  }

  const out: string[] = [];
  let bytes = 0;
  for (let index = lines.length - 1; index >= 0 && out.length < maxLines; index -= 1) {
    const line = lines[index] ?? "";
    const size = Buffer.byteLength(line, "utf-8") + (out.length > 0 ? 1 : 0);
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buffer = Buffer.from(line, "utf-8");
        let start = Math.max(0, buffer.length - maxBytes);
        while (start < buffer.length) {
          const byte = buffer[start];
          if (byte === undefined || (byte & 0xc0) !== 0x80) {
            break;
          }
          start += 1;
        }
        out.unshift(buffer.subarray(start).toString("utf-8"));
      }
      break;
    }
    out.unshift(line);
    bytes += size;
  }

  return {
    text: out.join("\n"),
    truncated: true,
  };
}

export class ShellOutputAccumulator {
  private readonly startedAtMs = Date.now();
  private mode: ShellOutputMode = "result";
  private resultBody = "";
  private liveTail = "";
  private totalBytes = 0;
  private totalLines = 0;
  private spillFilePath: string | null = null;
  private spillStream: fs.WriteStream | null = null;
  private spillWritesFailed = false;
  private liveTailTruncated = false;

  constructor(private readonly command: string) {}

  get currentMode(): ShellOutputMode {
    return this.mode;
  }

  ingest(chunk: string): ShellOutputUpdate | null {
    if (chunk.length === 0) {
      return null;
    }

    this.totalBytes += Buffer.byteLength(chunk, "utf-8");
    this.totalLines += countLines(chunk);

    if (this.mode === "result") {
      const nextBody = `${this.resultBody}${chunk}`;
      if (this.shouldPromote(nextBody)) {
        this.promote(nextBody);
        return {
          mode: this.mode,
          dispatch: "replace",
          text: this.render(),
        };
      }

      this.resultBody = nextBody;
      return {
        mode: this.mode,
        dispatch: "append",
        text: chunk,
      };
    }

    this.appendToSpill(chunk);
    this.updateLiveTail(`${this.liveTail}${chunk}`);
    return {
      mode: this.mode,
      dispatch: "replace",
      text: this.render(),
    };
  }

  async close(): Promise<void> {
    const stream = this.spillStream;
    this.spillStream = null;
    if (!stream) {
      return;
    }

    await new Promise<void>((resolve) => {
      stream.end(() => resolve());
      stream.once("error", () => resolve());
    });
  }

  private shouldPromote(nextBody: string): boolean {
    return (
      Date.now() - this.startedAtMs >= SHELL_RESULT_PROMOTION_RUNTIME_MS ||
      Buffer.byteLength(nextBody, "utf-8") > SHELL_RESULT_PROMOTION_MAX_BYTES ||
      this.totalLines > SHELL_RESULT_PROMOTION_MAX_LINES
    );
  }

  private promote(fullBody: string): void {
    this.mode = "log";
    this.ensureSpillStream();
    this.appendToSpill(fullBody);
    this.resultBody = "";
    this.updateLiveTail(fullBody);
  }

  private updateLiveTail(text: string): void {
    const trimmed = trimTail(text, SHELL_LIVE_TAIL_MAX_LINES, SHELL_LIVE_TAIL_MAX_BYTES);
    this.liveTail = trimmed.text;
    this.liveTailTruncated = this.liveTailTruncated || trimmed.truncated;
  }

  private render(): string {
    if (this.mode === "result") {
      return renderShellMessage(this.command, this.resultBody);
    }

    const header = ["[live tail mode: showing latest output only]"];
    if (this.liveTailTruncated) {
      header.push("[older output truncated]");
    }
    if (this.spillFilePath) {
      header.push(`[full output saved to: ${this.spillFilePath}]`);
    }

    const body = [header.join("\n"), this.liveTail].filter((part) => part.length > 0).join("\n\n");
    return renderShellMessage(this.command, body);
  }

  private ensureSpillStream(): void {
    if (this.spillStream || this.spillWritesFailed) {
      return;
    }

    try {
      const logDir = path.join(os.tmpdir(), "bigbud-shell-logs");
      fs.mkdirSync(logDir, { recursive: true });
      const filePath = path.join(logDir, `shell-${Date.now()}-${crypto.randomUUID()}.log`);
      const stream = fs.createWriteStream(filePath, { flags: "a" });
      stream.on("error", () => {
        this.spillWritesFailed = true;
        this.spillStream = null;
      });
      this.spillFilePath = filePath;
      this.spillStream = stream;
    } catch {
      this.spillWritesFailed = true;
      this.spillFilePath = null;
      this.spillStream = null;
    }
  }

  private appendToSpill(text: string): void {
    if (text.length === 0) {
      return;
    }

    if (!this.spillStream) {
      return;
    }

    try {
      this.spillStream.write(text);
    } catch {
      this.spillWritesFailed = true;
      this.spillStream = null;
      this.spillFilePath = null;
    }
  }
}
