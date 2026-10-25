import { describe, expect, it } from "vitest";

import { createMemoryStorage } from "../../lib/storage";
import { createBannerDismissalStore } from "./bannerDismissal.store";

const key = JSON.stringify(["subscription-limits", "claude-agent-sdk", "stale"]);

describe("app-run banner dismissal", () => {
  it("survives renderer reload in the same run, but resets for a new run", () => {
    const storage = createMemoryStorage();
    const first = createBannerDismissalStore(storage);
    first.getState().observeRun("app-one");
    first.getState().dismiss(key, "app-one");
    const reloaded = createBannerDismissalStore(storage);
    reloaded.getState().observeRun("app-one");
    expect(reloaded.getState().dismissed.has(key)).toBe(true);
    reloaded.getState().observeRun("app-two");
    expect(reloaded.getState().dismissed.size).toBe(0);
    const restarted = createBannerDismissalStore(storage);
    restarted.getState().observeRun("app-two");
    expect(restarted.getState().dismissed.size).toBe(0);
  });

  it("does not reset on absent welcome during reconnect", () => {
    const store = createBannerDismissalStore(createMemoryStorage());
    store.getState().observeRun("app-one");
    store.getState().dismiss(key);
    const before = store.getState();
    store.getState().observeRun(undefined);
    store.getState().observeRun(null);
    store.getState().observeRun("app-one");
    expect(store.getState()).toBe(before);
    expect(store.getState().dismissed.has(key)).toBe(true);
  });

  it("adopts dismissal before first welcome and persists it after the run becomes known", () => {
    const storage = createMemoryStorage();
    const store = createBannerDismissalStore(storage);
    store.getState().dismiss(key);
    store.getState().observeRun(undefined);
    store.getState().observeRun("app-one");
    expect(store.getState().dismissed.has(key)).toBe(true);
    const reloaded = createBannerDismissalStore(storage);
    expect(reloaded.getState().serverRunId).toBe("app-one");
    expect(reloaded.getState().dismissed.has(key)).toBe(true);
  });

  it("dismisses correctly even before the new run observation effect executes", () => {
    const store = createBannerDismissalStore(createMemoryStorage());
    store.getState().observeRun("old-run");
    store.getState().dismiss("old-key");
    store.getState().dismiss("new-key", "new-run");
    expect(store.getState().serverRunId).toBe("new-run");
    expect([...store.getState().dismissed]).toEqual(["new-key"]);
  });

  it("does not evict earlier dismissals, and preserves immutable snapshots", () => {
    const store = createBannerDismissalStore(createMemoryStorage());
    store.getState().observeRun("run");
    store.getState().dismiss(key);
    const previous = store.getState().dismissed;
    for (let index = 0; index < 2100; index++) store.getState().dismiss(`independent-${index}`);
    expect(store.getState().dismissed.has(key)).toBe(true);
    expect(store.getState().dismissed.size).toBe(2101);
    expect(previous.size).toBe(1);
  });

  it.each([
    "not json",
    JSON.stringify({ state: null, version: 0 }),
    JSON.stringify({ state: { serverRunId: 12, dismissed: [key] }, version: 0 }),
    JSON.stringify({ state: { serverRunId: "run", dismissed: [null] }, version: 0 }),
    JSON.stringify({ state: { serverRunId: "run", dismissed: "not an array" }, version: 0 }),
  ])("ignores malformed persistence: %s", (raw) => {
    const storage = createMemoryStorage();
    storage.setItem("bigbud:session-banner-dismissals", raw);
    const store = createBannerDismissalStore(storage);
    expect(store.getState().dismissed.size).toBe(0);
    expect(() => store.getState().dismiss(key, "run")).not.toThrow();
    expect(store.getState().dismissed.has(key)).toBe(true);
  });
});
