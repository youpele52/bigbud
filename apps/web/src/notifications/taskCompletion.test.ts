import { afterEach, describe, expect, it, vi } from "vitest";

import { useStore } from "../stores/main";
import type { Thread } from "../models/types";
import { showCompletionToast, showSystemTaskCompletionNotification } from "./taskCompletion";
import { toastManager } from "../components/ui/toast";

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
    vi.restoreAllMocks();
  });

  it("uses truthful Agent update copy through the desktop notification bridge", async () => {
    const show = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("window", { desktopBridge: { notifications: { show } }, dispatchEvent: vi.fn() });
    await expect(
      showSystemTaskCompletionNotification({
        ...candidate,
        kind: "update",
        assistantSummary: "Still working",
      }),
    ).resolves.toBe(true);
    expect(show).toHaveBeenCalledWith({
      title: "Agent update",
      body: "Thread: Still working",
      threadId: "thread-1",
    });
  });

  it("upgrades a visible info update to success without losing View navigation", () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("update-toast");
    const update = vi.spyOn(toastManager, "update").mockImplementation(() => {});
    const navigate = vi.fn();
    showCompletionToast({ ...candidate, kind: "update", messageId: "upgrade-message" }, navigate);
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ type: "info", title: "Agent update" }),
    );
    add.mock.calls[0]![0].actionProps?.onClick?.({} as never);
    expect(navigate).toHaveBeenCalledWith({ to: "/$threadId", params: { threadId: "thread-1" } });
    showCompletionToast(
      { ...candidate, kind: "completed", messageId: "upgrade-message" },
      navigate,
    );
    expect(add).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      "update-toast",
      expect.objectContaining({ type: "success", title: "Task completed" }),
    );
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
