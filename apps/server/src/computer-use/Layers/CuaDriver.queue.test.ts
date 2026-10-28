import { describe, expect, it } from "vitest";

import { makeCuaDriverCallQueue } from "./CuaDriver.queue.ts";

const never = () => new Promise<never>(() => undefined);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Cua driver call queue", () => {
  it("runs work in order", async () => {
    const queue = makeCuaDriverCallQueue();
    const order: string[] = [];
    await Promise.all([
      queue.enqueue(async () => order.push("first")),
      queue.enqueue(async () => order.push("second")),
    ]);
    expect(order).toEqual(["first", "second"]);
  });

  it("settles the call in flight, rejects queued calls, and runs later work", async () => {
    const queue = makeCuaDriverCallQueue();
    const reached: string[] = [];
    const inFlight = queue.enqueue(async () => {
      reached.push("click");
      return queue.abortable(never());
    });
    const queued = queue.enqueue(async () => {
      reached.push("type_text");
    });
    await settle();
    queue.halt(new Error("Computer use was stopped by the user."));

    await expect(inFlight).rejects.toThrow("stopped by the user");
    await expect(queued).rejects.toThrow("stopped by the user");
    await expect(queue.enqueue(async () => "after")).resolves.toBe("after");
    expect(reached).toEqual(["click"]);
  });

  it("still runs work that survives a halt arriving before its turn", async () => {
    const queue = makeCuaDriverCallQueue();
    const blocker = queue.enqueue(() => queue.abortable(never()));
    const reset = queue.enqueue(async () => "reset", { survivesHalt: true });
    await settle();
    queue.halt(new Error("first stop"));
    queue.halt(new Error("second stop"));
    await expect(blocker).rejects.toThrow("first stop");
    await expect(reset).resolves.toBe("reset");
  });

  it("tells work enqueued before a halt that it is stale", async () => {
    const queue = makeCuaDriverCallQueue();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let current: boolean | null = null;
    const work = queue.enqueue(async (isCurrent) => {
      await gate;
      current = isCurrent();
    });
    await settle();
    queue.halt(new Error("halted"));
    release();
    await work;
    expect(current).toBe(false);
  });
});
