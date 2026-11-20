import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalInputQueue } from "./TerminalInputQueue";

async function flush() {
  for (let index = 0; index < 6; index++) await Promise.resolve();
}

function fixture() {
  const writes: string[] = [];
  const resolvers: Array<() => void> = [];
  const queue = new TerminalInputQueue(
    (data) =>
      new Promise<void>((resolve) => {
        writes.push(data);
        resolvers.push(resolve);
      }),
    vi.fn(),
  );
  const settle = async () => {
    resolvers.shift()?.();
    await flush();
  };
  return { queue, writes, settle, flush };
}

function deferred() {
  let resolve!: (value: string | null) => void;
  const promise = new Promise<string | null>((done) => (resolve = done));
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TerminalInputQueue deferred paste", () => {
  it("holds keys typed during an upload until the pasted path is written first", async () => {
    const { queue, writes, flush } = fixture();
    const path = deferred();
    queue.enqueueDeferred(path.promise, 60_000);
    queue.enqueue("a");
    queue.enqueue("b");
    expect(writes).toEqual([]);
    path.resolve("\x1b[200~/tmp/p.png\x1b[201~");
    await flush();
    expect(writes.join("")).toBe("\x1b[200~/tmp/p.png\x1b[201~ab");
  });

  it("never coalesces typed input ahead of a waiting paste", async () => {
    const { queue, writes, settle, flush } = fixture();
    queue.enqueue("x");
    const path = deferred();
    queue.enqueueDeferred(path.promise, 60_000);
    queue.enqueue("y");
    await settle();
    expect(writes).toEqual(["x"]);
    path.resolve("P");
    await flush();
    expect(writes.join("")).toBe("xPy");
  });

  it("stops coalescing at a waiting paste instead of skipping it", async () => {
    const { queue, writes, settle, flush } = fixture();
    queue.enqueue("a");
    queue.enqueue("b");
    const path = deferred();
    queue.enqueueDeferred(path.promise, 60_000);
    queue.enqueue("c");
    await settle();
    expect(writes).toEqual(["a", "b"]);
    await settle();
    expect(writes).toEqual(["a", "b"]);
    path.resolve("P");
    await flush();
    expect(writes.join("")).toBe("abPc");
  });

  it("releases the position with nothing written on failure or timeout", async () => {
    vi.useFakeTimers();
    const { queue, writes, flush } = fixture();
    queue.enqueueDeferred(Promise.reject(new Error("upload failed")), 60_000);
    queue.enqueue("a");
    await flush();
    expect(writes).toEqual(["a"]);
    const { queue: slow, writes: slowWrites, flush: slowFlush } = fixture();
    slow.enqueueDeferred(new Promise(() => {}), 1_000);
    slow.enqueue("b");
    await vi.advanceTimersByTimeAsync(1_001);
    await slowFlush();
    expect(slowWrites).toEqual(["b"]);
  });

  it("discards a waiting paste when the terminal generation changes", async () => {
    const { queue, writes, flush } = fixture();
    const path = deferred();
    queue.enqueueDeferred(path.promise, 60_000);
    queue.clear();
    queue.enqueue("new shell");
    await flush();
    path.resolve("/old/generation/path");
    await flush();
    expect(writes).toEqual(["new shell"]);
  });
});
