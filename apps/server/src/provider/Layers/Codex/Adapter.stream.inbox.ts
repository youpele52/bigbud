import type { ProviderEvent } from "@bigbud/contracts";

/** A synchronous bounded producer and exactly one ordered async consumer. */
export function createCodexEventInbox(input: {
  readonly consume: (event: ProviderEvent) => Promise<void>;
  readonly overflow: (event: ProviderEvent, cause: unknown) => (() => Promise<void>) | void;
  readonly maxEvents?: number;
  readonly maxBytes?: number;
}) {
  const queue: { event: ProviderEvent; bytes: number }[] = [];
  let bytes = 0;
  let active = false;
  let closed = false;
  let failureCompletion: (() => Promise<void>) | undefined;
  const fail = (event: ProviderEvent, cause: unknown) => {
    if (closed) return;
    closed = true;
    failureCompletion = input.overflow(event, cause) ?? undefined;
    void drain();
  };
  const drain = async () => {
    if (active) return;
    active = true;
    try {
      while (queue.length > 0) {
        const entry = queue[0]!;
        try {
          await input.consume(entry.event);
        } catch (cause) {
          fail(entry.event, cause);
          break;
        }
        queue.shift();
        bytes -= entry.bytes;
      }
      const complete = failureCompletion;
      failureCompletion = undefined;
      if (complete) await complete();
    } catch {
      /* Shutdown can interrupt a bounded downstream offer. */
    } finally {
      active = false;
    }
  };
  return {
    offer(event: ProviderEvent): void {
      if (closed) return;
      let size: number;
      try {
        size = Buffer.byteLength(JSON.stringify(event));
      } catch (cause) {
        fail(event, cause);
        return;
      }
      if (
        queue.length >= (input.maxEvents ?? 4096) ||
        bytes + size > (input.maxBytes ?? 16 * 1024 * 1024)
      ) {
        fail(
          event,
          new Error(
            "Codex event inbox overflowed; event delivery and the native turn outcome are uncertain.",
          ),
        );
        return;
      }
      queue.push({ event, bytes: size });
      bytes += size;
      void drain();
    },
    close(): void {
      closed = true;
      queue.length = 0;
      bytes = 0;
    },
  };
}
