import type { ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { resolveContinuedThreadId, waitForContinuedThread } from "./useContinueInNewThread.logic";

const SOURCE = "source-1" as ThreadId;
const REQUESTED = "client-fork" as ThreadId;
const forked = (forkThreadId: string) =>
  ({
    id: `forked-${forkThreadId}`,
    kind: "thread.forked",
    payload: { forkThreadId, reason: "recovery-failed" },
    createdAt: "2026-10-15T10:00:00.000Z",
  }) as never;
const source = (activities: unknown[] = []) => ({ id: SOURCE, activities }) as never;

describe("continued thread navigation target", () => {
  it("opens the requested fork once it exists", () => {
    const threads = [source(), { id: REQUESTED, activities: [] } as never];
    expect(
      resolveContinuedThreadId({ sourceThreadId: SOURCE, requestedThreadId: REQUESTED, threads }),
    ).toBe(REQUESTED);
  });

  it("opens the existing automatic fork when the server kept that one instead", () => {
    const threads = [source([forked("auto-fork")])];
    expect(
      resolveContinuedThreadId({ sourceThreadId: SOURCE, requestedThreadId: REQUESTED, threads }),
    ).toBe("auto-fork");
  });

  it("never returns an unused client id", () => {
    expect(
      resolveContinuedThreadId({
        sourceThreadId: SOURCE,
        requestedThreadId: REQUESTED,
        threads: [source()],
      }),
    ).toBeNull();
  });

  it("waits for the store to show the fork and gives up after the timeout", async () => {
    let state = { threads: [source()] };
    const listeners = new Set<(next: typeof state) => void>();
    const store = {
      getState: () => state,
      subscribe: (listener: (next: typeof state) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const waiting = waitForContinuedThread(
      { sourceThreadId: SOURCE, requestedThreadId: REQUESTED, timeoutMs: 1_000 },
      store as never,
    );
    state = { threads: [source([forked("auto-fork")])] };
    for (const listener of listeners) listener(state);
    await expect(waiting).resolves.toBe("auto-fork");
    await expect(
      waitForContinuedThread(
        { sourceThreadId: "other" as ThreadId, requestedThreadId: REQUESTED, timeoutMs: 10 },
        store as never,
      ),
    ).resolves.toBeNull();
  });
});
