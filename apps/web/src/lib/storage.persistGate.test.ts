import { describe, expect, it, vi } from "vitest";
import type { PersistStorage } from "zustand/middleware";
import { skipUnchangedPersistWrites } from "./storage.persistGate";

type State = { layout: Record<string, string>; tabs?: string[] };

function fixture() {
  const base = {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  } satisfies PersistStorage<State>;
  return { base, gated: skipUnchangedPersistWrites<State>(base)! };
}

describe("skipUnchangedPersistWrites", () => {
  it("writes once while every persisted slice keeps its identity", () => {
    const { base, gated } = fixture();
    const state = { layout: { a: "split" }, tabs: ["one"] };
    gated.setItem("key", { state, version: 1 });
    gated.setItem("key", { state: { ...state }, version: 1 });
    expect(base.setItem).toHaveBeenCalledOnce();
  });

  it("writes again when any slice, the slice set or the version changes", () => {
    const { base, gated } = fixture();
    const state = { layout: { a: "split" }, tabs: ["one"] };
    gated.setItem("key", { state, version: 1 });
    gated.setItem("key", { state: { ...state, tabs: ["one", "two"] }, version: 1 });
    gated.setItem("key", { state: { layout: state.layout }, version: 1 });
    gated.setItem("key", { state: { layout: state.layout }, version: 2 });
    expect(base.setItem).toHaveBeenCalledTimes(4);
  });

  it("forgets the last write after hydration, removal or a failed write", () => {
    const { base, gated } = fixture();
    const state = { layout: {}, tabs: [] };
    gated.setItem("key", { state, version: 1 });
    gated.getItem("key");
    gated.setItem("key", { state, version: 1 });
    gated.removeItem("key");
    gated.setItem("key", { state, version: 1 });
    expect(base.setItem).toHaveBeenCalledTimes(3);
    base.setItem.mockImplementationOnce(() => {
      throw new Error("quota");
    });
    const next = { layout: { b: "chat-only" }, tabs: [] };
    expect(() => gated.setItem("key", { state: next, version: 1 })).toThrow("quota");
    gated.setItem("key", { state: next, version: 1 });
    expect(base.setItem).toHaveBeenCalledTimes(5);
  });
});
