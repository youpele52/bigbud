import { describe, expect, it, vi } from "vitest";
import { PERSISTED_STATE_KEY, persistState, readPersistedState } from "./ui.store.projects";
import { initialState } from "./ui.store.types";
import { useUiStateStore } from "./ui.store";

describe("sidebar action persistence", () => {
  it("resets only the order, leaving hidden items unchanged", () => {
    const previous = useUiStateStore.getState();
    try {
      useUiStateStore.setState({
        sidebarActionOrder: [
          "projects",
          ...initialState.sidebarActionOrder.filter((id) => id !== "projects"),
        ],
        hiddenSidebarActions: ["usage", "games"],
        sidebarPrimaryGroupSize: 5,
      });
      useUiStateStore.getState().resetSidebarActionOrder();
      expect(useUiStateStore.getState().sidebarActionOrder).toEqual(
        initialState.sidebarActionOrder,
      );
      expect(useUiStateStore.getState().hiddenSidebarActions).toEqual(["usage", "games"]);
      expect(useUiStateStore.getState().sidebarPrimaryGroupSize).toBe(4);
    } finally {
      useUiStateStore.setState(previous);
    }
  });

  it("restores action order and visibility after hydration", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });

    try {
      persistState({
        ...initialState,
        sidebarPrimaryGroupSize: 5,
        sidebarActionOrder: [
          "usage",
          "resource-monitor",
          "games",
          "scheduled",
          "pinned",
          "chats",
          "projects",
          "remote-workspaces",
        ],
        hiddenSidebarActions: ["games", "usage"],
      });
      expect(readPersistedState()).toMatchObject({
        sidebarPrimaryGroupSize: 5,
        sidebarActionOrder: [
          "usage",
          "resource-monitor",
          "games",
          "scheduled",
          "pinned",
          "chats",
          "projects",
          "remote-workspaces",
        ],
        hiddenSidebarActions: ["games", "usage"],
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retires saved marketplace preferences without resetting other saved context", () => {
    const values = new Map<string, string>([
      [
        PERSISTED_STATE_KEY,
        JSON.stringify({
          sidebarActionOrder: [
            "usage",
            "plugins",
            "scheduled",
            "games",
            "resource-monitor",
            "pinned",
            "chats",
            "projects",
            "remote-workspaces",
          ],
          hiddenSidebarActions: ["plugins", "games"],
          chatsExpanded: false,
          favouritesExpanded: false,
          projectsExpanded: false,
          lastActiveThreadId: "saved-thread",
          projectOrderCwds: ["/saved-project"],
          threadLastVisitedAtById: { "saved-thread": "2026-10-29T00:00:00.000Z" },
        }),
      ],
    ]);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    try {
      const state = readPersistedState();
      expect(state).toMatchObject({
        sidebarActionOrder: [
          "usage",
          "scheduled",
          "games",
          "resource-monitor",
          "pinned",
          "chats",
          "projects",
          "remote-workspaces",
        ],
        sidebarPrimaryGroupSize: 4,
        hiddenSidebarActions: ["games"],
        chatsExpanded: false,
        favouritesExpanded: false,
        projectsExpanded: false,
        lastActiveThreadId: "saved-thread",
        threadLastVisitedAtById: { "saved-thread": "2026-10-29T00:00:00.000Z" },
      });
      expect(JSON.parse(values.get(PERSISTED_STATE_KEY)!).projectOrderCwds).toEqual([
        "/saved-project",
      ]);
      persistState(state);
      expect(readPersistedState().sidebarPrimaryGroupSize).toBe(4);
      expect(JSON.parse(values.get(PERSISTED_STATE_KEY)!).hiddenSidebarActions).toEqual(["games"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
