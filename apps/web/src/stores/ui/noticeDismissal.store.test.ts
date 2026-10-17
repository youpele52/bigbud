import { afterEach, expect, it } from "vitest";

import { useContextWindowDismissalStore } from "./contextWindowDismissal.store";
import { MAX_NOTICE_DISMISSALS } from "./noticeDismissal.retention";
import { useThreadNoticeDismissalStore } from "./threadNoticeDismissal.store";

afterEach(() => {
  useThreadNoticeDismissalStore.setState({ dismissed: new Set() });
  useContextWindowDismissalStore.setState({ rearmTokensByThread: new Map() });
});

it.each(["revisions", "threads"] as const)(
  "bounds notice dismissal %s and evicts oldest first",
  (kind) => {
    const { dismiss } = useThreadNoticeDismissalStore.getState();
    const key = (index: number) =>
      kind === "revisions"
        ? JSON.stringify(["one-thread", "setup", `fingerprint-${index}`])
        : JSON.stringify([`thread-${index}`, "setup", "one-fingerprint"]);
    const count = MAX_NOTICE_DISMISSALS * 4;
    for (let index = 0; index < count; index++) dismiss(key(index));
    const retained = useThreadNoticeDismissalStore.getState().dismissed;
    expect(retained.size).toBe(MAX_NOTICE_DISMISSALS);
    expect([...retained]).toEqual(
      Array.from({ length: MAX_NOTICE_DISMISSALS }, (_, index) =>
        key(count - MAX_NOTICE_DISMISSALS + index),
      ),
    );
  },
);

it("refreshes an explicitly re-dismissed notice without mutating prior snapshots", () => {
  const { dismiss } = useThreadNoticeDismissalStore.getState();
  for (let index = 0; index < MAX_NOTICE_DISMISSALS; index++) dismiss(`key-${index}`);
  const previous = useThreadNoticeDismissalStore.getState().dismissed;
  dismiss("key-0");
  dismiss("new-key");
  const retained = useThreadNoticeDismissalStore.getState().dismissed;
  expect(retained.size).toBe(MAX_NOTICE_DISMISSALS);
  expect(retained.has("key-0")).toBe(true);
  expect(retained.has("key-1")).toBe(false);
  expect([...retained].slice(-2)).toEqual(["key-0", "new-key"]);
  expect(previous.has("key-1")).toBe(true);
  expect(previous.has("new-key")).toBe(false);
});

it("bounds context dismissals even when old threads never mount to rearm", () => {
  const { setRearmTokens } = useContextWindowDismissalStore.getState();
  const count = MAX_NOTICE_DISMISSALS * 4;
  for (let index = 0; index < count; index++) setRearmTokens(String(index), index);
  const retained = useContextWindowDismissalStore.getState().rearmTokensByThread;
  expect(retained.size).toBe(MAX_NOTICE_DISMISSALS);
  expect([...retained]).toEqual(
    Array.from({ length: MAX_NOTICE_DISMISSALS }, (_, index) => {
      const value = count - MAX_NOTICE_DISMISSALS + index;
      return [String(value), value];
    }),
  );
});

it("refreshes context dismissal order and preserves explicit rearming and prior snapshots", () => {
  const { setRearmTokens } = useContextWindowDismissalStore.getState();
  for (let index = 0; index < MAX_NOTICE_DISMISSALS; index++) setRearmTokens(String(index), index);
  const previous = useContextWindowDismissalStore.getState().rearmTokensByThread;
  setRearmTokens("0", 190_000);
  setRearmTokens("new-thread", 200_000);
  let retained = useContextWindowDismissalStore.getState().rearmTokensByThread;
  expect(retained.size).toBe(MAX_NOTICE_DISMISSALS);
  expect(retained.get("0")).toBe(190_000);
  expect(retained.has("1")).toBe(false);
  expect(previous.get("0")).toBe(0);
  expect(previous.has("1")).toBe(true);
  setRearmTokens("0", undefined);
  retained = useContextWindowDismissalStore.getState().rearmTokensByThread;
  expect(retained.has("0")).toBe(false);
  expect(retained.get("new-thread")).toBe(200_000);
});

it("keeps context thresholds independent from eviction of notice revisions", () => {
  useContextWindowDismissalStore.getState().setRearmTokens("thread-one", 190_000);
  const { dismiss } = useThreadNoticeDismissalStore.getState();
  for (let index = 0; index < MAX_NOTICE_DISMISSALS * 2; index++) dismiss(`revision-${index}`);
  expect(useContextWindowDismissalStore.getState().rearmTokensByThread.get("thread-one")).toBe(
    190_000,
  );
});
