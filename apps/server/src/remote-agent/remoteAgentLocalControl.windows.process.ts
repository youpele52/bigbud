import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolveLocalWorkspaceWatchAgentBinary } from "./localWorkspaceWatchAgent.binary.ts";
import { verifyNativeInspectionCapability } from "./localNativeInspection.capability.ts";

const MAX_FRAME = 2 * 65_536 + 65_536 + 512;
/** Owns one native transport. Output is always drained, including while closing. */
export class WindowsControlProcess {
  private buffered = Buffer.alloc(0);
  private closing = false;
  private readonly exited: Promise<void>;
  private readonly child: ChildProcessWithoutNullStreams;
  private onFrame: (frame: string) => void = () => {};
  private onFailure: () => void = () => {};

  private constructor(binary: string, mode: "server" | "client") {
    this.child = spawn(binary, [`--local-control-${mode}`], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    const child = this.child;
    this.exited = new Promise((resolve) => {
      child.once("close", () => {
        resolve();
        if (!this.closing) this.fail();
      });
      // An error (including a failed kill) is not proof of process settlement.
      // Node also emits close after a failed spawn; only close releases the backend lease.
      child.once("error", () => this.fail());
    });
    child.stderr.resume();
    child.stdin.on("error", () => this.fail());
    child.stdout.on("data", (chunk: Buffer) => {
      // Do not pause output: native workers must be able to finish even after caller cancellation.
      if (this.closing) return;
      if (this.buffered.length + chunk.length > MAX_FRAME) {
        this.fail();
        return;
      }
      this.buffered = Buffer.concat([this.buffered, chunk]);
      for (;;) {
        const newline = this.buffered.indexOf(10);
        if (newline < 0) return;
        const line = this.buffered.subarray(0, newline).toString("utf8");
        this.buffered = this.buffered.subarray(newline + 1);
        try {
          this.onFrame(line);
        } catch {
          this.fail();
          return;
        }
        if (this.closing) return;
      }
    });
  }
  static async open(mode: "server" | "client") {
    const binary = resolveLocalWorkspaceWatchAgentBinary();
    await verifyNativeInspectionCapability(
      binary,
      Date.now() + 5000,
      new AbortController().signal,
      "local-control-pipe=1",
    );
    return new WindowsControlProcess(binary, mode);
  }
  listen(frame: (frame: string) => void, failed: () => void) {
    this.onFrame = frame;
    this.onFailure = failed;
  }
  send(frame: string) {
    if (
      this.closing ||
      frame.includes("\n") ||
      Buffer.byteLength(frame) > MAX_FRAME ||
      this.child.stdin.writableLength > 2 * MAX_FRAME
    ) {
      this.fail();
      return false;
    }
    this.child.stdin.write(`${frame}\n`, (error) => {
      if (error) this.fail();
    });
    return true;
  }
  private fail() {
    if (this.closing) return;
    this.onFailure();
    void this.close();
  }
  async close() {
    if (!this.closing) {
      this.closing = true;
      this.buffered = Buffer.alloc(0);
      this.child.stdin.end();
      // Native stdout writes may block if the parent stops reading. We keep draining and
      // forcibly settle only this owned helper after the bounded graceful interval.
      const kill = setTimeout(() => this.child.kill("SIGKILL"), 2000);
      this.exited.finally(() => clearTimeout(kill));
    }
    await this.exited;
  }
}
