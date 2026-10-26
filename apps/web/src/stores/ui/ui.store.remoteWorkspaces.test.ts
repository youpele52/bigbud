import { afterEach, describe, expect, it, vi } from "vitest";
import { PERSISTED_STATE_KEY, persistState, readPersistedState } from "./ui.store.projects";

function storage(saved: unknown) {
  const values = new Map([[PERSISTED_STATE_KEY, JSON.stringify(saved)]]);
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  return values;
}

afterEach(() => vi.unstubAllGlobals());

describe("remote workspace preference compatibility", () => {
  it("preserves legacy expansion, section position, and visibility and writes new names", () => {
    const values = storage({
      remoteProjectsExpanded: true,
      sidebarActionOrder: ["remote-projects", "projects", "chats"],
      hiddenSidebarActions: ["remote-projects"],
    });
    const state = readPersistedState();
    expect(state.remoteWorkspacesExpanded).toBe(true);
    expect(state.sidebarActionOrder.slice(0, 3)).toEqual([
      "remote-workspaces",
      "projects",
      "chats",
    ]);
    expect(state.hiddenSidebarActions).toEqual(["remote-workspaces"]);
    persistState(state);
    const saved = JSON.parse(values.get(PERSISTED_STATE_KEY)!);
    expect(saved.remoteWorkspacesExpanded).toBe(true);
    expect(saved).not.toHaveProperty("remoteProjectsExpanded");
    expect(JSON.stringify(saved)).not.toContain("remote-projects");
  });

  it("prefers the new expansion field even when false and deduplicates old/new section IDs", () => {
    storage({
      remoteWorkspacesExpanded: false,
      remoteProjectsExpanded: true,
      sidebarActionOrder: ["remote-workspaces", "remote-projects", "projects"],
      hiddenSidebarActions: ["remote-projects", "remote-workspaces"],
    });
    const state = readPersistedState();
    expect(state.remoteWorkspacesExpanded).toBe(false);
    expect(state.sidebarActionOrder.slice(0, 2)).toEqual(["remote-workspaces", "projects"]);
    expect(state.hiddenSidebarActions).toEqual(["remote-workspaces"]);
  });
});
