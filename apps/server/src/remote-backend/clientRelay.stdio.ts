import { Duplex, type Readable, type Writable } from "node:stream";

/** Adapt separate SSH stdin/stdout pipes to Node's HTTP socket interface, with bounded buffering. */
export class ClientRelayStdioSocket extends Duplex {
  private timer: NodeJS.Timeout | undefined;
  private timeoutMs = 0;
  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
  ) {
    super({ allowHalfOpen: false, highWaterMark: 64 * 1024 });
    input.on("data", (chunk: Buffer) => {
      this.touch();
      if (!this.push(chunk)) input.pause();
    });
    input.once("end", () => this.push(null));
    input.once("error", () => this.destroy(new Error("Relay input failed.")));
    output.once("error", () => this.destroy(new Error("Relay output failed.")));
  }
  override _read() {
    this.input.resume();
  }
  override _write(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.touch();
    this.output.write(chunk, encoding, callback);
  }
  override _final(callback: (error?: Error | null) => void) {
    this.output.end(callback);
  }
  override _destroy(error: Error | null, callback: (error: Error | null) => void) {
    if (this.timer) clearTimeout(this.timer);
    this.input.destroy();
    this.output.destroy();
    callback(error);
  }
  setTimeout(timeout: number, callback?: () => void) {
    this.timeoutMs = timeout;
    if (callback) this.once("timeout", callback);
    this.touch();
    return this;
  }
  ref() {
    this.timer?.ref();
    return this;
  }
  unref() {
    this.timer?.unref();
    return this;
  }
  setNoDelay() {
    return this;
  }
  setKeepAlive() {
    return this;
  }
  private touch() {
    if (this.timer) clearTimeout(this.timer);
    this.timer =
      this.timeoutMs > 0 ? setTimeout(() => this.emit("timeout"), this.timeoutMs) : undefined;
    this.timer?.unref();
  }
}
