import { ThreadId } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";

import { runOrchestra, type OrchestraAssignmentDraft } from "./orchestra.runner";

const assignments: OrchestraAssignmentDraft[] = [
  {
    id: "a",
    modelSelection: { provider: "codex", model: "gpt-5" },
    prompt: "First task",
  },
  {
    id: "b",
    modelSelection: { provider: "opencode", model: "gpt-5" },
    prompt: "Second task",
  },
];

describe("runOrchestra", () => {
  it("starts all assignments immediately in together mode", async () => {
    const createParentThread = vi.fn().mockResolvedValue({
      threadId: ThreadId.makeUnsafe("parent-thread"),
      title: "Nocturne",
    });
    const createThread = vi
      .fn()
      .mockResolvedValueOnce(ThreadId.makeUnsafe("thread-a"))
      .mockResolvedValueOnce(ThreadId.makeUnsafe("thread-b"));
    const waitForThreadCompletion = vi.fn();
    const createHandoffSeedMessage = vi.fn();

    const result = await runOrchestra(
      { assignments, mode: "together", scoreName: "" },
      {
        createParentThread,
        createThread,
        createHandoffSeedMessage,
        waitForThreadCompletion,
      },
    );

    expect(result.parentThreadId).toEqual(ThreadId.makeUnsafe("parent-thread"));
    expect(result.threadIds).toEqual([
      ThreadId.makeUnsafe("thread-a"),
      ThreadId.makeUnsafe("thread-b"),
    ]);
    expect(createParentThread).toHaveBeenCalledWith({
      assignments,
      mode: "together",
      scoreName: "",
    });
    expect(createThread).toHaveBeenCalledTimes(2);
    expect(createThread).toHaveBeenNthCalledWith(1, {
      assignment: assignments[0],
      index: 0,
      parentThread: {
        threadId: ThreadId.makeUnsafe("parent-thread"),
        title: "Nocturne",
      },
    });
    expect(createThread).toHaveBeenNthCalledWith(2, {
      assignment: assignments[1],
      index: 1,
      parentThread: {
        threadId: ThreadId.makeUnsafe("parent-thread"),
        title: "Nocturne",
      },
    });
    expect(createHandoffSeedMessage).not.toHaveBeenCalled();
    expect(waitForThreadCompletion).not.toHaveBeenCalled();
  });

  it("waits for each thread and injects handoff seed messages in sequence mode", async () => {
    const createParentThread = vi.fn().mockResolvedValue({
      threadId: ThreadId.makeUnsafe("parent-thread"),
      title: "Prelude",
    });
    const createThread = vi
      .fn()
      .mockResolvedValueOnce(ThreadId.makeUnsafe("thread-a"))
      .mockResolvedValueOnce(ThreadId.makeUnsafe("thread-b"));
    const waitForThreadCompletion = vi.fn().mockResolvedValue(undefined);
    const createHandoffSeedMessage = vi.fn().mockResolvedValue({
      id: "seed-1",
      role: "user",
      text: "handoff",
      attachments: [],
      turnId: null,
      streaming: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const result = await runOrchestra(
      { assignments, mode: "sequence", scoreName: "Prelude" },
      {
        createParentThread,
        createThread,
        createHandoffSeedMessage,
        waitForThreadCompletion,
      },
    );

    expect(result.parentThreadId).toEqual(ThreadId.makeUnsafe("parent-thread"));
    expect(result.threadIds).toEqual([
      ThreadId.makeUnsafe("thread-a"),
      ThreadId.makeUnsafe("thread-b"),
    ]);
    expect(createThread).toHaveBeenNthCalledWith(1, {
      assignment: assignments[0],
      index: 0,
      parentThread: {
        threadId: ThreadId.makeUnsafe("parent-thread"),
        title: "Prelude",
      },
    });
    expect(waitForThreadCompletion).toHaveBeenNthCalledWith(1, ThreadId.makeUnsafe("thread-a"));
    expect(createHandoffSeedMessage).toHaveBeenCalledWith(ThreadId.makeUnsafe("thread-a"));
    expect(createThread).toHaveBeenNthCalledWith(2, {
      assignment: assignments[1],
      index: 1,
      parentThread: {
        threadId: ThreadId.makeUnsafe("parent-thread"),
        title: "Prelude",
      },
      seedMessages: [
        {
          id: "seed-1",
          role: "user",
          text: "handoff",
          attachments: [],
          turnId: null,
          streaming: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(waitForThreadCompletion).toHaveBeenNthCalledWith(2, ThreadId.makeUnsafe("thread-b"));
  });
});
