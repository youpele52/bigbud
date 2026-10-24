import { randomBytes } from "node:crypto";
import type { Readable, Writable } from "node:stream";

/** Quiescence belongs to the backend instance, not the requester that may disappear. */
export function createSupervisorPreparation(input: Readable, output: Writable, timeoutMs = 5000) {
  const operation = randomBytes(16).toString("hex");
  let identity: string | undefined;
  let quiesced = false;
  let closed = false;
  let buffered = "";
  let preparation: Promise<boolean> | undefined;
  let pending: ((ready: boolean) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settle = (ready: boolean) => {
    clearTimeout(timer);
    timer = undefined;
    pending?.(ready);
    pending = undefined;
  };
  const fail = () => settle(false);
  input.on("error", fail);
  input.on("end", fail);
  output.on("error", fail);
  input.on("data", (chunk) => {
    if (closed) return;
    buffered += String(chunk);
    if (buffered.length > 2048) {
      fail();
      input.destroy();
      return;
    }
    let end: number;
    while ((end = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      try {
        const value = JSON.parse(line);
        if (value?.operation !== operation) continue;
        if (value.quiesced === true) {
          // Keep a late acknowledgment even after the requesting connection/timer is gone.
          quiesced = true;
          settle(true);
        } else fail();
      } catch {
        fail();
      }
    }
  });
  return {
    isQuiesced: () => quiesced,
    prepare: (expected: string): Promise<boolean> => {
      if (closed || (identity !== undefined && identity !== expected))
        return Promise.resolve(false);
      identity = expected;
      if (quiesced) return Promise.resolve(true);
      if (preparation) return preparation;
      const attempt = new Promise<boolean>((resolve) => {
        pending = resolve;
        timer = setTimeout(fail, timeoutMs);
        // Reuse this instance's correlation id: the parent can re-ack an already applied gate.
        output.write(`${JSON.stringify({ operation, identity })}\n`);
      });
      preparation = attempt.finally(() => {
        preparation = undefined;
      });
      return preparation;
    },
    close: () => {
      closed = true;
      fail();
      input.destroy();
      output.destroy();
    },
  };
}
