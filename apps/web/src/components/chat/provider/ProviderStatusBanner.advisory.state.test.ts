import { describe, expect, it, vi } from "vitest";
import {
  createRetainedHistoryAdvisoryState,
  RETAINED_HISTORY_DISMISSAL_KEY,
} from "./ProviderStatusBanner.advisory.state";

describe("retained-history advisory state", () => {
  it("persists only the stable dismissal flag and reminds once on the next runtime", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
    const firstBoot = createRetainedHistoryAdvisoryState(() => storage);
    expect(firstBoot.getSnapshot()).toBe(false);
    firstBoot.dismiss();
    expect(firstBoot.getSnapshot()).toBe(true);
    expect(firstBoot.claimStartupToast()).toBe(false);
    expect([...values]).toEqual([[RETAINED_HISTORY_DISMISSAL_KEY, "true"]]);

    const nextBoot = createRetainedHistoryAdvisoryState(() => storage);
    expect(nextBoot.getSnapshot()).toBe(true);
    expect(nextBoot.claimStartupToast()).toBe(true);
    expect(nextBoot.claimStartupToast()).toBe(false);
  });

  it.each(["getter", "read", "write"])(
    "retains in-memory dismissal after storage %s failure",
    (failure) => {
      const storage = {
        getItem: () => {
          if (failure === "read") throw new Error("Storage denied");
          return null;
        },
        setItem: () => {
          if (failure === "write") throw new Error("Quota exceeded");
        },
      };
      const state = createRetainedHistoryAdvisoryState(() => {
        if (failure === "getter") throw new Error("SecurityError");
        return storage;
      });
      const listener = vi.fn();
      const unsubscribe = state.subscribe(listener);
      expect(state.getSnapshot()).toBe(false);
      expect(() => state.dismiss()).not.toThrow();
      expect(state.getSnapshot()).toBe(true);
      expect(listener).toHaveBeenCalledOnce();
      unsubscribe();
      const remounted = vi.fn();
      const unsubscribeRemount = state.subscribe(remounted);
      expect(state.getSnapshot()).toBe(true);
      expect(state.claimStartupToast()).toBe(false);
      unsubscribeRemount();
    },
  );

  it("does not mistake malformed stored data for dismissal", () => {
    const state = createRetainedHistoryAdvisoryState(() => ({
      getItem: () => '{"message":"some unrelated error"}',
      setItem: () => {},
    }));
    expect(state.getSnapshot()).toBe(false);
    expect(state.claimStartupToast()).toBe(false);
  });
});
