import { describe, expect, it, vi } from "vitest";
import { persistState, readPersistedState } from "./ui.store.projects";
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
        hiddenSidebarActions: ["plugins", "games"],
      });
      useUiStateStore.getState().resetSidebarActionOrder();
      expect(useUiStateStore.getState().sidebarActionOrder).toEqual(
        initialState.sidebarActionOrder,
      );
      expect(useUiStateStore.getState().hiddenSidebarActions).toEqual(["plugins", "games"]);
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
        sidebarActionOrder: [
          "usage",
          "games",
          "scheduled",
          "plugins",
          "pinned",
          "chats",
          "projects",
          "remote-projects",
        ],
        hiddenSidebarActions: ["games", "plugins"],
      });
      expect(readPersistedState()).toMatchObject({
        sidebarActionOrder: [
          "usage",
          "games",
          "scheduled",
          "plugins",
          "pinned",
          "chats",
          "projects",
          "remote-projects",
        ],
        hiddenSidebarActions: ["games", "plugins"],
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
