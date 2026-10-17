import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const MAX_FRAME_BYTES = 128 * 1024;
const REQUIRED_CAPABILITIES = ["snapshot", "process-query", "retry", "collection-status"];
const helloFixture = readFileSync(
  new URL("../../protocol/system-monitor/fixtures/v1.frames", import.meta.url),
  "utf8",
).match(/^hello=([\da-f]+)$/m)?.[1];
if (!helloFixture) throw new Error("system monitor Hello fixture missing");
const HELLO_FRAME = Buffer.from(helloFixture, "hex");
const SHUTDOWN_FRAME = Buffer.from([0, 0, 0, 2, 98, 0]);

function varint(bytes: Uint8Array, start: number): [number, number] {
  let value = 0;
  let factor = 1;
  for (let offset = start; offset < bytes.length && offset - start < 10; offset++) {
    const byte = bytes[offset]!;
    value += (byte & 127) * factor;
    if (!Number.isSafeInteger(value)) break;
    if (!(byte & 128)) return [value, offset + 1];
    factor *= 128;
  }
  throw new Error("invalid system monitor varint");
}

function helloAckFields(payload: Uint8Array): Map<number, number | string[]> {
  let [tag, offset] = varint(payload, 0);
  if (tag !== 18) throw new Error("staged supervisor did not return system monitor HelloAck");
  let length: number;
  [length, offset] = varint(payload, offset);
  if (offset + length !== payload.length) throw new Error("invalid system monitor HelloAck length");
  const fields = new Map<number, number | string[]>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (offset < payload.length) {
    [tag, offset] = varint(payload, offset);
    const field = Math.floor(tag / 8);
    const kind = tag % 8;
    if (kind === 0) {
      let value: number;
      [value, offset] = varint(payload, offset);
      fields.set(field, value);
    } else if (kind === 2) {
      [length, offset] = varint(payload, offset);
      if (offset + length > payload.length) throw new Error("truncated system monitor HelloAck");
      const value = decoder.decode(payload.subarray(offset, offset + length));
      if (field === 6) fields.set(6, [...((fields.get(6) as string[] | undefined) ?? []), value]);
      else fields.set(field, [value]);
      offset += length;
    } else throw new Error("unsupported system monitor HelloAck field");
  }
  return fields;
}

/** Verify monitor mode on the exact binary staged for packaging, without subscribing or sampling. */
export async function smokeTestSystemMonitorBinary(binaryPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binaryPath, ["--system-monitor"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = Buffer.alloc(0);
    let greeted = false;
    let settled = false;
    let stderr = "";
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      if (error) reject(error);
      else resolve();
    };
    const deadline = setTimeout(
      () => finish(new Error(`system monitor handshake timed out: ${stderr.trim()}`)),
      5_000,
    );
    child.once("error", finish);
    child.stdin.on("error", () => undefined);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4_096);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled || greeted) return;
      if (output.length + chunk.length > MAX_FRAME_BYTES * 2) {
        finish(new Error("system monitor output overflow"));
        return;
      }
      output = Buffer.concat([output, chunk]);
      if (output.length < 4) return;
      const length = output.readUInt32BE(0);
      if (!length || length > MAX_FRAME_BYTES) {
        finish(new Error("system monitor frame limit mismatch"));
        return;
      }
      if (output.length < length + 4) return;
      try {
        const fields = helloAckFields(output.subarray(4, length + 4));
        const capabilities = fields.get(6) as string[] | undefined;
        if (
          fields.get(1) !== 1 ||
          !(Number(fields.get(2)) >= 1) ||
          fields.get(3) !== MAX_FRAME_BYTES ||
          !REQUIRED_CAPABILITIES.every((capability) => capabilities?.includes(capability))
        ) {
          finish(new Error("staged supervisor lacks compatible system monitor mode"));
          return;
        }
        greeted = true;
        child.stdin.write(SHUTDOWN_FRAME);
        child.stdin.end();
      } catch (error) {
        finish(error as Error);
      }
    });
    child.once("exit", (code, signal) => {
      if (!greeted || code !== 0 || signal !== null) {
        finish(new Error(`staged supervisor system monitor handshake failed (${code}, ${signal})`));
      } else {
        finish();
      }
    });
    child.stdin.write(HELLO_FRAME);
  });
}
