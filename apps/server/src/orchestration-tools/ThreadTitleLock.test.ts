import { CommandId, EventId, ThreadId, type OrchestrationEvent } from "@bigbud/contracts";
import { describe, expect, it, afterEach } from "vitest";

import {
  getThreadTitleVersion,
  isThreadTitleLocked,
  lockThreadTitle,
  noteThreadTitleCommand,
  rehydrateThreadTitleLocks,
  resetThreadTitleLockForTests,
  shouldAllowAutoTitleReplace,
} from "./ThreadTitleLock.ts";

describe("ThreadTitleLock", () => {
  afterEach(() => {
    resetThreadTitleLockForTests();
  });

  it("locks the thread title and bumps the version", () => {
    expect(getThreadTitleVersion("thread-1")).toBe(0);
    const version = lockThreadTitle("thread-1");
    expect(version).toBe(1);
    expect(isThreadTitleLocked("thread-1")).toBe(true);
    expect(getThreadTitleVersion("thread-1")).toBe(1);
  });

  it("blocks auto title replacement when locked", () => {
    lockThreadTitle("thread-1");
    expect(
      shouldAllowAutoTitleReplace({
        threadId: "thread-1",
        currentTitle: "New thread",
      }),
    ).toBe(false);
  });

  it("ignores auto-generated title commands when noting renames", () => {
    noteThreadTitleCommand({
      threadId: "thread-1",
      commandId: "server:thread-title-rename:abc",
      title: "Generated title",
    });
    expect(isThreadTitleLocked("thread-1")).toBe(false);
  });

  it("locks on agent and client rename commands", () => {
    noteThreadTitleCommand({
      threadId: "thread-1",
      commandId: "agent:thread-rename:abc",
      title: "Summer sun",
    });
    expect(isThreadTitleLocked("thread-1")).toBe(true);

    resetThreadTitleLockForTests();

    noteThreadTitleCommand({
      threadId: "thread-1",
      commandId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      title: "Sidebar rename",
    });
    expect(isThreadTitleLocked("thread-1")).toBe(true);
  });

  it("does not lock on provider metadata title sync", () => {
    noteThreadTitleCommand({
      threadId: "thread-1",
      commandId: "provider:thread-meta-update:abc",
      title: "Provider title",
    });
    expect(isThreadTitleLocked("thread-1")).toBe(false);
  });

  it("rehydrates lock state from persisted thread metadata events", () => {
    rehydrateThreadTitleLocks([
      {
        type: "thread.meta-updated",
        eventId: EventId.makeUnsafe("evt-1"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-1"),
        sequence: 1,
        occurredAt: "2026-06-24T00:00:00.000Z",
        commandId: CommandId.makeUnsafe("agent:thread-rename:abc"),
        payload: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          title: "Summer sun",
          updatedAt: "2026-06-24T00:00:00.000Z",
        },
      },
    ] as unknown as ReadonlyArray<OrchestrationEvent>);

    expect(isThreadTitleLocked("thread-1")).toBe(true);
    expect(getThreadTitleVersion("thread-1")).toBe(1);
  });
});
