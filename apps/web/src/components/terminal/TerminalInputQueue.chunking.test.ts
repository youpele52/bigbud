import { TERMINAL_WRITE_MAX_CODE_UNITS } from "@bigbud/contracts/workspace/terminal.ts";
import { describe, expect, it, vi } from "vitest";
import { TerminalInputQueue } from "./TerminalInputQueue";

/** Each write resolves on the next microtask, like a fast server. */
async function drainAll(items: string[], maxWriteUnits?: number) {
  const writes: string[] = [];
  const onFailure = vi.fn();
  const queue = new TerminalInputQueue(
    async (data) => {
      writes.push(data);
    },
    onFailure,
    maxWriteUnits,
  );
  for (const item of items) queue.enqueue(item);
  for (let turn = 0; turn < 64 && queue.queued > 0; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { writes, onFailure };
}

describe("TerminalInputQueue paste chunking", () => {
  it("splits a paste larger than the server write limit into ordered writes", async () => {
    const paste = Array.from({ length: 200_000 }, (_, index) =>
      String.fromCharCode(97 + (index % 26)),
    ).join("");
    const { writes, onFailure } = await drainAll([paste]);

    expect(onFailure).not.toHaveBeenCalled();
    expect(writes.every((write) => write.length <= TERMINAL_WRITE_MAX_CODE_UNITS)).toBe(true);
    expect(writes.join("")).toBe(paste);
    expect(writes.length).toBe(Math.ceil(paste.length / TERMINAL_WRITE_MAX_CODE_UNITS));
  });

  it("never splits a surrogate pair at a chunk boundary", async () => {
    const paste = `abc${"\u{1F600}".repeat(4)}`;
    const { writes } = await drainAll([paste], 4);

    expect(writes.join("")).toBe(paste);
    for (const write of writes) {
      const last = write.charCodeAt(write.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  it("makes progress on a leading surrogate pair even with a tiny limit", async () => {
    const paste = "\u{1F600}\u{1F601}";
    const { writes } = await drainAll([paste], 1);

    expect(writes.join("")).toBe(paste);
    expect(writes).toHaveLength(2);
  });

  it("keeps input typed around a large paste in order", async () => {
    const paste = "p".repeat(10);
    const { writes } = await drainAll(["before", paste, "after"], 4);

    expect(writes.join("")).toBe(`before${paste}after`);
    expect(writes.every((write) => write.length <= 4 || write === "before")).toBe(true);
  });
});
