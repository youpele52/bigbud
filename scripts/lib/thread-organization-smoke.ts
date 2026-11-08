import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

function fields(bytes: Buffer): Map<number, Buffer | number> {
  let offset = 0;
  const result = new Map<number, Buffer | number>();
  const uint = () => {
    let value = 0;
    for (let shift = 0; shift <= 49; shift += 7) {
      const byte = bytes[offset++];
      if (byte === undefined) throw new Error("Truncated organisation smoke response");
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128) && Number.isSafeInteger(value)) return value;
    }
    throw new Error("Invalid organisation smoke integer");
  };
  while (offset < bytes.length) {
    const key = uint();
    const tag = Math.floor(key / 8);
    if (tag === 0 || result.has(tag)) throw new Error("Invalid organisation smoke field");
    if (key % 8 === 0) result.set(tag, uint());
    else if (key % 8 === 2) {
      const length = uint();
      if (length > bytes.length - offset) throw new Error("Truncated organisation smoke field");
      result.set(tag, bytes.subarray(offset, offset + length));
      offset += length;
    } else throw new Error("Unsupported organisation smoke wire type");
  }
  return result;
}

/** Synthetic package smoke, independent of server source imports/build configuration. */
export async function smokeTestThreadOrganizationBinary(binary: string): Promise<void> {
  const frames = readFileSync(
    new URL("../../protocol/thread-organization/scheduling-fixture.hex", import.meta.url),
    "utf8",
  )
    .trim()
    .split(/\s+/)
    .map((hex) => {
      const frame = Buffer.from(hex, "hex");
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(frame.length);
      return Buffer.concat([prefix, frame]);
    });
  const child = spawn(binary, ["--thread-organization", "scheduling-owner", "1"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = new Promise<void>((resolve, reject) => {
    let pending = Buffer.alloc(0);
    let ready = false;
    timer = setTimeout(() => reject(new Error("Organisation artifact smoke timed out")), 5000);
    child.once("error", reject);
    child.stdin.on("error", reject);
    child.stdout.on("error", reject);
    child.stderr.resume();
    child.once("exit", () => {
      if (!ready) reject(new Error("Organisation artifact exited before activation"));
    });
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        if (pending.length + chunk.length > 1048580)
          throw new Error("Organisation artifact output capacity exceeded");
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 4) {
          const length = pending.readUInt32BE(0);
          if (length === 0 || length > 1048576)
            throw new Error("Organisation artifact frame length invalid");
          if (pending.length < length + 4) break;
          const value = fields(pending.subarray(4, length + 4));
          pending = pending.subarray(length + 4);
          const nonce = value.get(1);
          if (
            !Buffer.isBuffer(nonce) ||
            nonce.toString() !== "scheduling-owner" ||
            value.get(2) !== 1
          )
            throw new Error("Organisation artifact owner mismatch");
          if (Buffer.isBuffer(value.get(3))) ready = true;
          const proposal = value.get(4);
          if (Buffer.isBuffer(proposal)) {
            if (!ready || fields(proposal).get(9) !== 2)
              throw new Error("Organisation artifact scheduling invalid");
            resolve();
          }
        }
      } catch (error) {
        reject(error);
      }
    });
    for (const frame of frames) child.stdin.write(frame);
  });
  try {
    await outcome;
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const wait = (ms: number) =>
      Promise.race([
        closed.then(() => true),
        new Promise<false>((resolve) => {
          stopTimer = setTimeout(() => resolve(false), ms);
        }),
      ]).finally(() => clearTimeout(stopTimer));
    if (!(await wait(2000))) {
      child.kill("SIGTERM");
      if (!(await wait(1000))) {
        child.kill("SIGKILL");
        if (!(await wait(2000))) throw new Error("Organisation artifact did not exit");
      }
    }
  }
}
