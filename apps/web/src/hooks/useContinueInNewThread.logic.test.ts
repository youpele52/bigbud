import type { ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { resolveContinuedThreadId, waitForContinuedThread } from "./useContinueInNewThread.logic";

const SOURCE = "source-1" as ThreadId;
const REQUESTED = "client-fork" as ThreadId;
const forked = (forkThreadId: string, lineage: Record<string, unknown> = {}) =>
  ({
    id: `forked-${forkThreadId}`,
    kind: "thread.forked",
    payload: { forkThreadId, reason: "recovery-failed", ...lineage },
    createdAt: "2026-10-15T10:00:00.000Z",
  }) as never;
const source = (activities: unknown[] = []) => ({ id: SOURCE, activities }) as never;
const fork = (id: string) => ({ id, activities: [] }) as never;
const command = { pendingMessageId: "m-2", failureEventId: "failure-2" };
const resolve = (threads: unknown[], sidebarIds: string[] = []) =>
  resolveContinuedThreadId({
    sourceThreadId: SOURCE,
    requestedThreadId: REQUESTED,
    command,
    threads: threads as never,
    sidebarThreadsById: Object.fromEntries(sidebarIds.map((id) => [id, { id }])) as never,
  });

describe("continued thread navigation target", () => {
  it("opens the requested fork once it exists", () => {
    expect(resolve([source(), fork(REQUESTED)])).toBe(REQUESTED);
  });

  it("opens the fork the server kept for this same message instead", () => {
    const kept = forked("auto-fork", { pendingMessageId: "m-2" });
    expect(resolve([source([kept]), fork("auto-fork")])).toBe("auto-fork");
  });

  it("never opens an older fork made for another message, nor a missing one", () => {
    const stale = forked("old-fork", { pendingMessageId: "m-1", failureEventId: "failure-1" });
    expect(resolve([source([stale]), fork("old-fork")])).toBeNull();
    const deleted = forked("gone-fork", { pendingMessageId: "m-2" });
    expect(resolve([source([deleted])])).toBeNull();
  });

  it("finds a fork the browser knows only from the sidebar summaries", () => {
    expect(resolve([source()], [REQUESTED])).toBe(REQUESTED);
    const kept = forked("auto-fork", { pendingMessageId: "m-2" });
    expect(resolve([source([kept])], ["auto-fork"])).toBe("auto-fork");
  });

  it("after the wait, opens the fork the server recorded for this message even if not loaded", async () => {
    const kept = forked("unloaded-fork", { pendingMessageId: "m-2" });
    const state = { threads: [source([kept])], sidebarThreadsById: {} };
    const store = { getState: () => state, subscribe: () => () => undefined };
    await expect(
      waitForContinuedThread(
        { sourceThreadId: SOURCE, requestedThreadId: REQUESTED, command, timeoutMs: 10 },
        store as never,
      ),
    ).resolves.toBe("unloaded-fork");
  });

  it("never opens a fork the store shows as being deleted, before or after the wait", async () => {
    const deleting = forked("deleting-fork", { pendingMessageId: "m-2" });
    const marked = { id: "deleting-fork", activities: [], deletingAt: "2026-10-15T10:00:01.000Z" };
    expect(resolve([source([deleting]), marked])).toBeNull();
    const state = {
      threads: [source([deleting])],
      sidebarThreadsById: { "deleting-fork": { deletingAt: "2026-10-15T10:00:01.000Z" } },
    };
    const store = { getState: () => state, subscribe: () => () => undefined };
    await expect(
      waitForContinuedThread(
        { sourceThreadId: SOURCE, requestedThreadId: REQUESTED, command, timeoutMs: 10 },
        store as never,
      ),
    ).resolves.toBeNull();
  });

  it("waits for the store to show the fork and gives up after the timeout", async () => {
    let state = { threads: [source()], sidebarThreadsById: {} };
    const listeners = new Set<(next: typeof state) => void>();
    const store = {
      getState: () => state,
      subscribe: (listener: (next: typeof state) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const waiting = waitForContinuedThread(
      { sourceThreadId: SOURCE, requestedThreadId: REQUESTED, command, timeoutMs: 1_000 },
      store as never,
    );
    state = {
      threads: [source([forked("auto-fork", { failureEventId: "failure-2" })]), fork("auto-fork")],
      sidebarThreadsById: {},
    };
    for (const listener of listeners) listener(state);
    await expect(waiting).resolves.toBe("auto-fork");
    await expect(
      waitForContinuedThread(
        {
          sourceThreadId: "other" as ThreadId,
          requestedThreadId: REQUESTED,
          command,
          timeoutMs: 10,
        },
        store as never,
      ),
    ).resolves.toBeNull();
  });
});
