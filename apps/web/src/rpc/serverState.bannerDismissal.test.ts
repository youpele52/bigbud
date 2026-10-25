import { afterEach, expect, it } from "vitest";

import { useBannerDismissalStore } from "../stores/ui/bannerDismissal.store";
import { appAtomRegistry } from "./atomRegistry";
import { emitWelcome, resetServerStateForTests, welcomeAtom } from "./serverState";

afterEach(() => {
  resetServerStateForTests();
  useBannerDismissalStore.setState({ serverRunId: null, dismissed: new Set() });
});

it("binds banner dismissal to lifecycle welcome even when no banners are mounted", () => {
  useBannerDismissalStore.setState({ serverRunId: null, dismissed: new Set() });
  useBannerDismissalStore.getState().dismiss("before-welcome");
  emitWelcome({ serverRunId: "one", cwd: "/test", projectName: "test" });
  expect(useBannerDismissalStore.getState().dismissed.has("before-welcome")).toBe(true);
  appAtomRegistry.set(welcomeAtom, null);
  expect(useBannerDismissalStore.getState().dismissed.has("before-welcome")).toBe(true);
  emitWelcome({ serverRunId: "one", cwd: "/test", projectName: "test" });
  expect(useBannerDismissalStore.getState().dismissed.has("before-welcome")).toBe(true);
  emitWelcome({ serverRunId: "two", cwd: "/test", projectName: "test" });
  expect(useBannerDismissalStore.getState().serverRunId).toBe("two");
  expect(useBannerDismissalStore.getState().dismissed.size).toBe(0);
});
