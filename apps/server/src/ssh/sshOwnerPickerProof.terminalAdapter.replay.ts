import type { PtySequencedData } from "../terminal/Services/PTY.ts";
import type { PickerProofTerminalReplay } from "./sshOwnerPickerProof.codec.terminal.ts";

const MAX_REPLAY_BYTES = 64 * 1024;
const POLL_MS = 25;

export function verifyProofTerminalReplay(
  lease: Uint8Array,
  afterSequence: number,
  receipt: PickerProofTerminalReplay,
) {
  const { gap, firstRetainedSequence, nextSequence, chunks } = receipt;
  if (!Buffer.from(receipt.lease).equals(lease))
    throw new Error("The replay does not match the proof PTY lease.");
  if (gap || firstRetainedSequence > afterSequence + 1)
    throw new Error("The proof terminal replay has a gap.");
  if (
    !Number.isSafeInteger(firstRetainedSequence) ||
    firstRetainedSequence < 1 ||
    !Number.isSafeInteger(nextSequence) ||
    nextSequence < afterSequence + 1 ||
    chunks.length !== nextSequence - afterSequence - 1 ||
    chunks.length > MAX_REPLAY_BYTES
  )
    throw new Error("The proof terminal replay cut is invalid.");
  let bytes = 0;
  for (const [index, chunk] of chunks.entries()) {
    bytes += chunk.data.byteLength;
    if (
      chunk.sequence !== afterSequence + index + 1 ||
      !chunk.data.byteLength ||
      bytes > MAX_REPLAY_BYTES
    )
      throw new Error("The proof terminal replay cut is invalid.");
  }
  return receipt;
}

type VerifiedCut = ReturnType<typeof verifyProofTerminalReplay>;

/** Proof-only byte replay, not a screen snapshot. Keep one decoder and a contiguous output cursor. */
export function makeProofTerminalOutput(
  initial: VerifiedCut & { readonly final?: boolean },
  poll: (afterSequence: number) => Promise<typeof initial> | undefined,
  fail: (cause: unknown) => void,
  finish?: () => void,
) {
  const text = new Set<(data: string) => void>();
  const sequenced = new Set<(event: PtySequencedData) => void>();
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let afterSequence = 0;
  let buffered: typeof initial | undefined = initial;
  let offset = 0;
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listening = () => !stopped && (text.size > 0 || sequenced.size > 0);
  const schedule = (delay: number) => {
    if (!listening() || running || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      running = true;
      void drain()
        .catch(fail)
        .finally(() => {
          running = false;
          schedule(POLL_MS);
        });
    }, delay);
    timer.unref();
  };
  async function drain() {
    if (!listening()) return;
    if (!buffered) {
      const pending = poll(afterSequence);
      if (!pending) return;
      const received = await pending;
      if (stopped) return;
      buffered = received;
    }
    const cut = buffered;
    while (listening() && offset < cut.chunks.length) {
      const chunk = cut.chunks[offset++]!;
      const data = decoder.decode(chunk.data, { stream: true });
      afterSequence = chunk.sequence;
      for (const callback of sequenced) callback({ sequence: chunk.sequence, data });
      if (data) for (const callback of text) callback(data);
    }
    if (offset === cut.chunks.length) {
      buffered = undefined;
      offset = 0;
      if (cut.final && !stopped) {
        const tail = decoder.decode();
        if (tail) for (const callback of text) callback(tail);
        finish?.();
      }
    }
  }
  function subscribe<A>(callbacks: Set<(data: A) => void>, callback: (data: A) => void) {
    if (!stopped) {
      callbacks.add(callback);
      schedule(0);
    }
    return () => callbacks.delete(callback);
  }
  return {
    onData: (callback: (data: string) => void) => subscribe(text, callback),
    onSequencedData: (callback: (event: PtySequencedData) => void) =>
      subscribe(sequenced, callback),
    stop() {
      stopped = true;
      clearTimeout(timer);
      buffered = undefined;
      text.clear();
      sequenced.clear();
    },
  };
}
