import { afterEach, describe, expect, it, vi } from "vitest";

import { useStore } from "../stores/main";
import type { Thread } from "../models/types";
import { showSystemTaskCompletionNotification } from "./taskCompletion";

let latestNotification: { click: () => void } | undefined;
let latestClick: (() => void) | undefined;

class FakeNotification {
  static permission = "granted";

  constructor() {
    latestNotification = { click: () => latestClick?.() };
  }

  addEventListener(event: string, listener: () => void): void {
    if (event === "click") {
      latestClick = listener;
    }
  }
}

function makeThread(id: string): Thread {
  return {
    id: id as never,
    codexThreadId: null,
    projectId: "project-1" as never,
    title: "Thread",
    modelSelection: { provider: "codex", model: "gpt-5" } as never,
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-09-28T00:00:00.000Z",
    archivedAt: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    latestTurn: null,
  };
}

const candidate = {
  threadId: "thread-1",
  projectId: "project-1",
  title: "Thread",
  completedAt: "2026-09-28T00:00:00.000Z",
  assistantSummary: null,
};

describe("system task completion notification clicks", () => {
  afterEach(() => {
    latestNotification = undefined;
    latestClick = undefined;
    useStore.setState({ threads: [], sidebarThreadsById: {} });
    vi.unstubAllGlobals();
  });

  it("routes the exact browser tab to the originating thread", async () => {
    const focus = vi.fn();
    const navigate = vi.fn();
    const openMainWindow = vi.fn();
    vi.stubGlobal("window", { focus, desktopBridge: { openMainWindow } });
    vi.stubGlobal("Notification", FakeNotification);
    useStore.setState({ threads: [makeThread("thread-1")], sidebarThreadsById: {} });

    await expect(showSystemTaskCompletionNotification(candidate, navigate)).resolves.toBe(true);

    latestNotification?.click();

    expect(focus).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith({
      to: "/$threadId",
      params: { threadId: "thread-1" },
    });
    expect(openMainWindow).not.toHaveBeenCalled();
  });

  it("focuses the tab without navigating when the thread is unavailable", async () => {
    const focus = vi.fn();
    const navigate = vi.fn();
    vi.stubGlobal("window", { focus });
    vi.stubGlobal("Notification", FakeNotification);

    await expect(showSystemTaskCompletionNotification(candidate, navigate)).resolves.toBe(true);

    latestNotification?.click();

    expect(focus).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });
});
