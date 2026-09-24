import { describe, expect, it, vi } from "vitest";
import { effectiveHiddenSidebarActions, requestShowPlugins } from "./Sidebar.actions.git";

describe("Plugins sidebar availability", () => {
  it("hides Plugins until Git is confirmed, without hiding fixed actions", () => {
    expect(effectiveHiddenSidebarActions([], "checking")).toEqual(["plugins"]);
    expect(effectiveHiddenSidebarActions([], "missing")).toEqual(["plugins"]);
    expect(effectiveHiddenSidebarActions([], "unknown")).toEqual(["plugins"]);
    expect(effectiveHiddenSidebarActions([], "available")).toEqual([]);
  });

  it("preserves the user's explicit hidden choices when Git becomes available", () => {
    expect(effectiveHiddenSidebarActions(["plugins", "games"], "available")).toEqual([
      "plugins",
      "games",
    ]);
  });

  it("does not reveal Plugins when Git is missing or cannot be checked", async () => {
    const show = vi.fn();
    const onMissing = vi.fn();
    const onUnknown = vi.fn();
    await requestShowPlugins({ check: async () => "missing", show, onMissing, onUnknown });
    await requestShowPlugins({ check: async () => "unknown", show, onMissing, onUnknown });
    expect(show).not.toHaveBeenCalled();
    expect(onMissing).toHaveBeenCalledOnce();
    expect(onUnknown).toHaveBeenCalledOnce();
    await requestShowPlugins({ check: async () => "available", show, onMissing, onUnknown });
    expect(show).toHaveBeenCalledOnce();
  });
});
