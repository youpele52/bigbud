import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { ownershipIdentity } from "@bigbud/shared/backendOwnership.control";
import { readOwnershipLock } from "@bigbud/shared/backendOwnership.record";
import { processStartToken, compareProcessStartToken } from "@bigbud/shared/processStartToken";

let yielded = false;
export function isOwnershipHandedOff(): boolean {
  return yielded;
}

/** A sticky backend-only gate: a yielding desktop never automatically retakes ownership. */
export function attachOwnershipHandoff(
  child: ChildProcess,
  stateDir: string,
  quiesce: () => void,
  isCurrent: () => boolean = () => true,
): void {
  const input = (child.stdio as ReadonlyArray<unknown>)[6] as Readable | null;
  const output = (child.stdio as ReadonlyArray<unknown>)[7] as Writable | null;
  if (!input || !output) return;
  let buffer = "";
  let operation: string | undefined;
  let processing = false;
  let closed = false;
  input.on("error", () => {});
  output.on("error", () => {});
  child.once("close", () => {
    closed = true;
    input.destroy();
    output.destroy();
  });
  input.on("data", (chunk) => {
    buffer += String(chunk);
    if (buffer.length > 8192) {
      input.destroy();
      return;
    }
    const end = buffer.indexOf("\n");
    if (end < 0) return;
    const raw = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (processing) return;
    processing = true;
    void (async () => {
      const request = JSON.parse(raw) as { operation?: unknown; identity?: unknown };
      if (typeof request.operation !== "string" || !/^[a-f0-9]{32}$/.test(request.operation))
        return;
      if (operation !== undefined && operation !== request.operation) return;
      const record = await readOwnershipLock(path.join(stateDir, "backend.lock"));
      const canonical = await realpath(stateDir);
      if (
        closed ||
        !isCurrent() ||
        !record ||
        record.pid !== child.pid ||
        compareProcessStartToken(record.startedAt, processStartToken(record.pid)) !== "same" ||
        request.identity !== ownershipIdentity(record, canonical)
      )
        return;
      if (operation === undefined) {
        operation = request.operation;
        yielded = true;
        quiesce();
      }
      // The gate is sticky, but its acknowledgment may have been lost or delayed.
      output.write(`${JSON.stringify({ operation, quiesced: true })}\n`);
    })()
      .catch(() => {})
      .finally(() => {
        processing = false;
      });
  });
}
