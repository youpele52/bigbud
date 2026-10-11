import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolveLocalWorkspaceWatchAgentBinary } from "../../../remote-agent/localWorkspaceWatchAgent.binary.ts";

/** Strict hex framing keeps paths and secret file bytes out of commands, diagnostics and delimiter parsing. */
export function decodeInspectionHex(value: string): string {
  if (!/^(?:[0-9a-f]{2})*$/.test(value)) throw new Error("Native inspection encoding rejected.");
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "hex"));
}

/** One bounded read-only helper connection; never spawns the user's executable. */
export class V2WindowsInspector {
  private child: ChildProcessWithoutNullStreams | undefined;
  private queue = Promise.resolve();
  private waiting = 0;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private pending:
    | { resolve: (value: string[]) => void; reject: (error: Error) => void }
    | undefined;
  private bytes = Buffer.alloc(0);

  constructor(private readonly binary = resolveLocalWorkspaceWatchAgentBinary) {}

  close() {
    clearTimeout(this.idle);
    const child = this.child;
    this.child = undefined;
    this.pending?.reject(new Error("Native read-only inspection unavailable."));
    this.pending = undefined;
    this.bytes = Buffer.alloc(0);
    child?.stdin.end();
    child?.kill(); // Only bigbud's owned read-only helper, never the inspected service.
  }

  private exchange(command: string, deadline = Date.now() + 5000): Promise<string[]> {
    if (Buffer.byteLength(command) > 131_070 || command.includes("\n"))
      return Promise.reject(new Error("Native inspection request bound exceeded."));
    return new Promise((resolve, reject) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        reject(new Error("Native inspection deadline exceeded."));
        return;
      }
      const timer = setTimeout(() => this.close(), remaining);
      this.pending = {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const child = this.child!;
      child.stdin.write(`${command}\n`, (error) => {
        if (error && this.child === child) this.close();
      });
    });
  }

  private async connect(deadline: number) {
    if (this.child) return;
    const child = spawn(this.binary(), ["--inspect-local"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    this.child = child;
    child.stderr.resume(); // Never copy native errors/paths into logs.
    child.on("error", () => {
      if (this.child === child) this.close();
    });
    child.on("exit", () => {
      if (this.child === child) this.close();
    });
    child.stdin.on("error", () => {
      if (this.child === child) this.close();
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.child !== child) return;
      if (this.bytes.length + chunk.length > 1_048_577) {
        this.close();
        return;
      }
      this.bytes = Buffer.concat([this.bytes, chunk]);
      const newline = this.bytes.indexOf(10);
      if (newline < 0) return;
      if (newline !== this.bytes.length - 1 || !this.pending) {
        this.close();
        return;
      }
      const fields = this.bytes.subarray(0, newline).toString("utf8").split("\t");
      this.bytes = Buffer.alloc(0);
      const pending = this.pending;
      this.pending = undefined;
      if (fields.shift() !== "OK") {
        const error: NodeJS.ErrnoException = new Error("Native read-only inspection rejected.");
        if (fields.length === 1 && fields[0] === "missing") error.code = "ENOENT";
        pending.reject(error);
      } else pending.resolve(fields);
    });
    const hello = await this.exchange("HELLO\t1", deadline);
    if (hello.length !== 1 || hello[0] !== "1") {
      this.close();
      throw new Error("Native inspection protocol incompatible.");
    }
  }

  request(command: string): Promise<string[]> {
    if (this.waiting >= 32)
      return Promise.reject(new Error("Native inspection capacity exceeded."));
    this.waiting++;
    const deadline = Date.now() + 5000;
    clearTimeout(this.idle);
    const work = this.queue.then(async () => {
      clearTimeout(this.idle);
      if (Date.now() >= deadline) throw new Error("Native inspection queue deadline exceeded.");
      await this.connect(deadline);
      this.child?.ref();
      for (const stream of [this.child?.stdin, this.child?.stdout, this.child?.stderr])
        (stream as { ref?: () => void } | undefined)?.ref?.();
      return await this.exchange(command, deadline);
    });
    this.queue = work.then(
      () => {},
      () => {},
    );
    return work.finally(() => {
      this.waiting--;
      if (this.waiting === 0) {
        this.idle = setTimeout(() => this.close(), 30_000);
        this.idle.unref();
        this.child?.unref();
        for (const stream of [this.child?.stdin, this.child?.stdout, this.child?.stderr])
          (stream as { unref?: () => void } | undefined)?.unref?.();
      }
    });
  }
}

export const v2WindowsInspector = new V2WindowsInspector();

export async function readV2WindowsRegistration(file: string): Promise<Buffer> {
  const result = await v2WindowsInspector.request(`READ\t${Buffer.from(file).toString("hex")}`);
  if (result.length !== 1 || result[0]!.length > 32_768)
    throw new Error("Registration bound exceeded.");
  return Buffer.from(decodeInspectionHex(result[0]!), "utf8");
}
