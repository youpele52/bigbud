import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../../lib/storage";
import { createProviderFailureNoticeStore } from "./providerFailureNotice.store";

describe("run-scoped provider failure notice", () => {
  it("keeps the first failure through repeats, navigation and provider replacement", () => {
    const store = createProviderFailureNoticeStore(createMemoryStorage());
    store.getState().observe("boot-1", "thread-1", "first failure");
    store.getState().observe("boot-1", "thread-1", null);
    store.getState().observe("boot-1", "thread-2", "other thread");
    store.getState().observe("boot-1", "thread-1", "replacement session failure");
    expect(store.getState().notices["thread-1"]).toEqual({
      message: "first failure",
      dismissed: false,
    });
    store.getState().dismiss("boot-1", "thread-1");
    store.getState().observe("boot-1", "thread-1", "third failure");
    expect(store.getState().notices["thread-1"]?.dismissed).toBe(true);
    expect(store.getState().notices["thread-2"]?.dismissed).toBe(false);
  });

  it("survives renderer reload; only a new bigbud run resets dismissal", () => {
    const storage = createMemoryStorage();
    const first = createProviderFailureNoticeStore(storage);
    first.getState().observe("boot-1", "thread-1", "expired key");
    first.getState().dismiss("boot-1", "thread-1");
    const reloaded = createProviderFailureNoticeStore(storage);
    reloaded.getState().observe("boot-1", "thread-1", "new provider session");
    expect(reloaded.getState().notices["thread-1"]?.dismissed).toBe(true);
    reloaded.getState().observe("boot-2", "thread-1", null);
    expect(reloaded.getState().notices).toEqual({});
    reloaded.getState().observe("boot-2", "thread-1", "new run failure");
    expect(reloaded.getState().notices["thread-1"]).toEqual({
      message: "new run failure",
      dismissed: false,
    });
    reloaded.getState().dismiss("boot-1", "thread-1");
    expect(reloaded.getState().notices["thread-1"]?.dismissed).toBe(false);
  });
});
