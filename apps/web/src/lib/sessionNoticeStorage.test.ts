import { afterEach, describe, expect, it, vi } from "vitest";

import { createSessionNoticeStorage } from "./sessionNoticeStorage";
import { createBannerDismissalStore } from "../stores/ui/bannerDismissal.store";

afterEach(() => vi.unstubAllGlobals());

describe("session notice storage fallback", () => {
  it.each(["getter", "read", "write", "remove"])(
    "remains usable when storage %s is denied",
    (failure) => {
      const values = new Map<string, string>();
      const localStorage = {
        getItem: (key: string) => {
          if (failure === "read") throw new Error("denied");
          return values.get(key) ?? null;
        },
        setItem: (key: string, value: string) => {
          if (failure === "write") throw new Error("quota");
          values.set(key, value);
        },
        removeItem: (key: string) => {
          if (failure === "remove") throw new Error("denied");
          values.delete(key);
        },
      };
      vi.stubGlobal("window", {
        get localStorage() {
          if (failure === "getter") throw new Error("SecurityError");
          return localStorage;
        },
      });
      const storage = createSessionNoticeStorage();
      const store = createBannerDismissalStore(storage);
      expect(() => {
        store.getState().observeRun("run");
        store.getState().dismiss("warning");
      }).not.toThrow();
      expect(store.getState().dismissed.has("warning")).toBe(true);
      expect(() => storage.removeItem("other-key")).not.toThrow();
      // Same fallback instance supports recreating the store. A whole renderer reload
      // cannot promise durability if the browser refuses all storage writes.
      const remounted = createBannerDismissalStore(storage);
      expect(remounted.getState().dismissed.has("warning")).toBe(true);
    },
  );
});
