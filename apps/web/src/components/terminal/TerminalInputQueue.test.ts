import { describe, expect, it, vi } from "vitest";
import { TERMINAL_INPUT_COALESCE_MAX_UNITS, TerminalInputQueue } from "./TerminalInputQueue";

function fixture() {
  const writes: string[] = [];
  const resolvers: Array<(error?: Error) => void> = [];
  const onFailure = vi.fn();
  const queue = new TerminalInputQueue(
    (data) =>
      new Promise<void>((resolve, reject) => {
        writes.push(data);
        resolvers.push((error) => (error ? reject(error) : resolve()));
      }),
    onFailure,
  );
  const settle = async (error?: Error) => {
    resolvers.shift()?.(error);
    await Promise.resolve();
    await Promise.resolve();
  };
  return { queue, writes, settle, onFailure };
}

describe("TerminalInputQueue", () => {
  it("sends the first input immediately and coalesces input typed while a write is in flight", async () => {
    const { queue, writes, settle } = fixture();
    queue.enqueue("a");
    expect(writes).toEqual(["a"]);
    queue.enqueue("\x1b[<64;10;5M");
    queue.enqueue("\x1b[<64;10;5M");
    queue.enqueue("b");
    expect(writes).toHaveLength(1);
    await settle();
    expect(writes).toEqual(["a", "\x1b[<64;10;5M\x1b[<64;10;5Mb"]);
  });

  it("bounds a coalesced write and never splits a large item", async () => {
    const { queue, writes, settle } = fixture();
    const half = "x".repeat(TERMINAL_INPUT_COALESCE_MAX_UNITS / 2 + 1);
    const paste = "p".repeat(TERMINAL_INPUT_COALESCE_MAX_UNITS * 2);
    queue.enqueue("first");
    queue.enqueue(half);
    queue.enqueue(half);
    queue.enqueue(paste);
    await settle();
    await settle();
    await settle();
    expect(writes).toEqual(["first", half, half, paste]);
  });

  it("drops queued input after a failed write and reports it once", async () => {
    const { queue, writes, settle, onFailure } = fixture();
    queue.enqueue("a");
    queue.enqueue("b");
    await settle(new Error("offline"));
    expect(onFailure).toHaveBeenCalledOnce();
    queue.enqueue("c");
    expect(writes).toEqual(["a", "c"]);
  });

  it("ignores completions from before a clear and input after dispose", async () => {
    const { queue, writes, settle } = fixture();
    queue.enqueue("a");
    queue.clear();
    queue.enqueue("b");
    await settle();
    expect(writes).toEqual(["a", "b"]);
    queue.dispose();
    queue.enqueue("c");
    expect(writes).toEqual(["a", "b"]);
  });
});
