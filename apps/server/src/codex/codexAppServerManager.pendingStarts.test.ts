import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { describe, expect, it, vi } from "vitest";

import {
  CODEX_START_CANCELLED_MESSAGE,
  CodexPendingStarts,
} from "./codexAppServerManager.pendingStarts.ts";
import { recordEarlySpawnError } from "./codexAppServerManager.process.spawnError.ts";

const threadA = ThreadId.makeUnsafe("thread-a");
const threadB = ThreadId.makeUnsafe("thread-b");

function fakeChild() {
  const kill = vi.fn(() => true);
  const child = Object.assign(new EventEmitter(), { kill });
  return { child: child as unknown as ChildProcessWithoutNullStreams, kill };
}

describe("CodexPendingStarts", () => {
  it("accepts the child and removes the entry", () => {
    const starts = new CodexPendingStarts();
    const { child, kill } = fakeChild();
    const pending = starts.begin(threadA);
    expect(starts.size).toBe(1);
    expect(pending.accept(child)).toBe(child);
    expect(kill).not.toHaveBeenCalled();
    expect(starts.size).toBe(0);
  });

  it("removes the entry and rethrows when the starter fails", () => {
    const starts = new CodexPendingStarts();
    const pending = starts.begin(threadA);
    expect(() => pending.fail(new Error("Remote Codex CLI version check timed out."))).toThrow(
      /timed out/,
    );
    expect(starts.size).toBe(0);
  });

  it("aborts the signal on cancel, and accept kills a child that arrives afterwards", () => {
    const starts = new CodexPendingStarts();
    const { child, kill } = fakeChild();
    const pending = starts.begin(threadA);

    starts.cancel(threadA);

    expect(pending.signal.aborted).toBe(true);
    expect(() => pending.accept(child)).toThrow(CODEX_START_CANCELLED_MESSAGE);
    expect(kill).toHaveBeenCalledOnce();
    expect(starts.size).toBe(0);
  });

  it("removes the entry when a cancelled starter rejects with the abort reason", () => {
    const starts = new CodexPendingStarts();
    const pending = starts.begin(threadA);
    starts.cancel(threadA);
    expect(() => pending.fail(pending.signal.reason)).toThrow(CODEX_START_CANCELLED_MESSAGE);
    expect(starts.size).toBe(0);
  });

  it("rethrows an early spawn error from accept and kills the child", async () => {
    const starts = new CodexPendingStarts();
    const { child, kill } = fakeChild();
    recordEarlySpawnError(child);
    const pending = starts.begin(threadA);
    process.nextTick(() => child.emit("error", new Error("spawn codex ENOENT")));
    await new Promise((resolve) => setImmediate(resolve));

    expect(() => pending.accept(child)).toThrow("spawn codex ENOENT");
    expect(kill).toHaveBeenCalledOnce();
    expect(starts.size).toBe(0);
  });

  it("cancels only the named thread, and cancelAll cancels every thread", () => {
    const starts = new CodexPendingStarts();
    const pendingA = starts.begin(threadA);
    const pendingB = starts.begin(threadB);

    starts.cancel(threadA);
    expect(pendingA.signal.aborted).toBe(true);
    expect(pendingB.signal.aborted).toBe(false);

    starts.cancelAll();
    expect(pendingB.signal.aborted).toBe(true);
    expect(() => pendingA.accept(fakeChild().child)).toThrow(CODEX_START_CANCELLED_MESSAGE);
    expect(() => pendingB.accept(fakeChild().child)).toThrow(CODEX_START_CANCELLED_MESSAGE);
    expect(starts.size).toBe(0);
  });

  it("does not cancel a start that begins after the cancel", () => {
    const starts = new CodexPendingStarts();
    starts.cancel(threadA);
    const { child } = fakeChild();
    expect(starts.begin(threadA).accept(child)).toBe(child);
  });
});
