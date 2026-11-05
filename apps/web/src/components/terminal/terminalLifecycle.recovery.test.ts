import { TerminalExecutionTargetError } from "@bigbud/contracts/workspace/terminal.ts";
import type { TerminalSessionSnapshot } from "@bigbud/contracts/workspace/terminal.ts";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetTerminalLaunch } from "../../lib/terminalLaunchBinding";
import {
  beginTerminalLifecycle,
  readTerminalLifecycle,
  useTerminalLifecycleStore,
} from "../../stores/terminal/terminalLifecycle.store";
import {
  recoverStaleTerminalLifecycle,
  subscribeTerminalLifecycleRefresh,
} from "./terminalLifecycle.recovery";

vi.mock("../ui/toast.manager", () => ({ toastManager: { add: vi.fn() } }));

const threadId = "stale-recovery";
const terminalId = "shell";
const stale = new TerminalExecutionTargetError({
  threadId,
  terminalId,
  executionTargetId: "local",
  detail: "changed",
  reason: "staleGeneration",
});

afterEach(() => {
  useTerminalLifecycleStore.setState({ operations: {} });
  forgetTerminalLaunch(threadId, terminalId);
});

describe("definitive stale terminal recovery", () => {
  it("releases a definitive refusal before independent view hydration settles", async () => {
    const operation = beginTerminalLifecycle(threadId, terminalId, "close")!;
    const snapshot: TerminalSessionSnapshot = {
      threadId,
      terminalId,
      cwd: "/new",
      worktreePath: null,
      dropPathMode: "posix",
      status: "running",
      pid: 7,
      history: "new session output",
      exitCode: null,
      exitSignal: null,
      updatedAt: "2026-10-29T00:00:00Z",
      runtimeGeneration: "new",
    };
    const onSnapshot = vi.fn();
    const unrelated = vi.fn();
    let parsed!: () => void;
    const hydrate = vi.fn(
      () =>
        new Promise<void>((done) => {
          parsed = done;
        }),
    );
    const unsubscribe = subscribeTerminalLifecycleRefresh(
      threadId,
      terminalId,
      onSnapshot,
      hydrate,
    );
    const unsubscribeOther = subscribeTerminalLifecycleRefresh(
      "other",
      terminalId,
      unrelated,
      unrelated,
    );
    try {
      const pending = recoverStaleTerminalLifecycle({
        error: stale,
        threadId,
        terminalId,
        operation,
        refresh: async () => snapshot,
      });
      await vi.waitFor(() => expect(hydrate).toHaveBeenCalledExactlyOnceWith(snapshot));
      expect(onSnapshot).toHaveBeenCalledExactlyOnceWith(snapshot);
      expect(unrelated).not.toHaveBeenCalled();
      expect(readTerminalLifecycle(threadId, terminalId)).toBeUndefined();
      parsed();
      expect(await pending).toBe(true);
      expect(readTerminalLifecycle(threadId, terminalId)).toBeUndefined();
    } finally {
      unsubscribe();
      unsubscribeOther();
    }
  });
  it("preserves structured refusal metadata across schema encoding", () => {
    const encoded = Schema.encodeSync(TerminalExecutionTargetError)(stale);
    const decoded = Schema.decodeUnknownSync(TerminalExecutionTargetError)(
      JSON.parse(JSON.stringify(encoded)),
    );
    expect(decoded).toMatchObject({
      _tag: "TerminalExecutionTargetError",
      reason: "staleGeneration",
      threadId,
      terminalId,
    });
  });
  it.each([
    new Error("This terminal has changed since the action was requested"),
    { ...stale, reason: undefined },
    { ...stale, threadId: "another-thread" },
  ])("does not abandon uncertain or unrelated operations: %o", async (error) => {
    const operation = beginTerminalLifecycle(threadId, terminalId, "restart")!;
    const refresh = vi.fn();
    expect(
      await recoverStaleTerminalLifecycle({ error, threadId, terminalId, operation, refresh }),
    ).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    expect(readTerminalLifecycle(threadId, terminalId)?.id).toBe(operation.id);
  });
  it("keeps operation ownership when the status refresh fails", async () => {
    const operation = beginTerminalLifecycle(threadId, terminalId, "close")!;
    const refresh = vi.fn().mockRejectedValue(new Error("connection lost"));
    await expect(
      recoverStaleTerminalLifecycle({ error: stale, threadId, terminalId, operation, refresh }),
    ).rejects.toThrow("connection lost");
    expect(readTerminalLifecycle(threadId, terminalId)?.id).toBe(operation.id);
  });
});
