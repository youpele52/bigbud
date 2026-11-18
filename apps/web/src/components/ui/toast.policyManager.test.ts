import type { ToastManager, ToastManagerAddOptions } from "@base-ui/react/toast";
import { describe, expect, it } from "vitest";
import { TOAST_CONDITION_COOLDOWN_MS } from "./toast.policy";
import { type ToastPolicyData, withToastPolicy } from "./toast.policyManager";

type AddOptions = ToastManagerAddOptions<ToastPolicyData>;

/** Minimal stand-in for Base UI's store: tracks open toasts and fires onClose. */
function createHarness() {
  let clock = 0;
  const open = new Map<string, AddOptions>();
  const calls: Array<[string, unknown]> = [];
  const shows: string[] = [];
  const close = (id?: string) => {
    for (const [toastId, toast] of open) {
      if (id !== undefined && toastId !== id) continue;
      open.delete(toastId);
      toast.onClose?.();
    }
  };
  const base = {
    " subscribe": () => () => {},
    add: (options: AddOptions) => {
      calls.push(["add", options]);
      open.set(options.id!, options);
      return options.id!;
    },
    update: (id: string, updates: Partial<AddOptions>) => {
      calls.push(["update", updates]);
      const current = open.get(id);
      if (current) open.set(id, { ...current, ...updates });
    },
    close: (id?: string) => {
      calls.push(["close", id]);
      close(id);
    },
    promise: () => Promise.reject(new Error("bypasses policy")),
  } as unknown as ToastManager<ToastPolicyData>;
  const policy = withToastPolicy(base, {
    now: () => clock,
    onShow: (reason) => shows.push(reason),
  });
  return {
    ...policy,
    open,
    calls,
    shows,
    /** Simulates the close button, swipe, dismiss-all, or a store timer. */
    userDismiss: (id: string) => close(id),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const slow = (description: string, type: "warning" | "error" = "warning") => ({
  data: { conditionKey: "slow" },
  description,
  timeout: 0,
  title: "Some requests are slow",
  type,
});

describe("withToastPolicy", () => {
  it("hands Base UI severity-resolved timeouts", () => {
    const h = createHarness();
    const persistent = h.manager.add({ title: "a", type: "warning", timeout: Infinity });
    const short = h.manager.add({ title: "b", type: "error", timeout: 8_000 });
    const long = h.manager.add({ title: "c", type: "success", timeout: 8_000 });
    const implicit = h.manager.add({ title: "d", type: "info" });
    expect(h.open.get(persistent)?.timeout).toBe(0);
    expect(h.open.get(short)?.timeout).toBe(15_000);
    expect(h.open.get(long)?.timeout).toBe(8_000);
    expect(h.open.get(implicit)?.timeout).toBe(10_000);
  });

  it("keeps the running timer on content updates and restarts it when the toast settles", () => {
    const h = createHarness();
    const id = h.manager.add({ title: "Working", type: "loading", timeout: 0 });
    h.calls.length = 0;
    h.manager.update(id, { title: "Still working", timeout: 0 });
    expect(h.calls).toEqual([["update", { title: "Still working" }]]);
    h.manager.update(id, { title: "Done", type: "success" });
    expect(h.calls[1]).toEqual(["update", { title: "Done", type: "success", timeout: 0 }]);
    h.manager.update(id, { title: "Done!" });
    expect(h.calls[2]).toEqual(["update", { title: "Done!" }]);
  });

  it("keeps a dismissed condition quiet while it keeps updating", () => {
    const h = createHarness();
    const id = h.manager.add(slow("2 requests"));
    h.userDismiss(id);
    h.manager.update(id, slow("3 requests"));
    h.manager.update(id, slow("20 requests"));
    expect(h.open.size).toBe(0);
  });

  it("does not re-show a dismissed condition when a new episode starts", () => {
    const h = createHarness();
    const first = h.manager.add(slow("2 requests"));
    h.userDismiss(first);
    h.manager.close(first);
    const second = h.manager.add(slow("1 request"));
    h.manager.update(second, slow("4 requests"));
    expect(h.open.size).toBe(0);
    expect(h.shows).toEqual(["add"]);
  });

  it("re-shows a dismissed condition after the cool-down or on escalation", () => {
    const h = createHarness();
    const id = h.manager.add(slow("2 requests"));
    h.userDismiss(id);
    h.manager.update(id, slow("2 requests failed", "error"));
    expect(h.open.get(id)?.type).toBe("error");

    h.userDismiss(id);
    h.advance(TOAST_CONDITION_COOLDOWN_MS - 1);
    h.manager.update(id, slow("still failing", "error"));
    expect(h.open.has(id)).toBe(false);
    h.advance(1);
    h.manager.update(id, slow("still failing", "error"));
    expect(h.open.get(id)?.description).toBe("still failing");
    expect(h.shows).toEqual(["add", "resurface", "resurface"]);
  });

  it("keeps dismissed retention progress quiet across stable-id re-adds but shows its outcome", () => {
    const h = createHarness();
    const data = { conditionKey: "thread-retention-progress:run-1" };
    const id = h.manager.add({ title: "Cleanup: 1/3", type: "loading", timeout: 0, data });
    h.userDismiss(id);
    // Forced re-publish and reconnect both re-add with the stable id.
    h.manager.add({ id, title: "Cleanup: 1/3", type: "loading", timeout: 0, data });
    h.manager.add({ id, title: "Cleanup: reconnecting…", type: "loading", timeout: 0, data });
    h.manager.update(id, { title: "Cleanup: 2/3", type: "loading", timeout: 0, data });
    expect(h.open.size).toBe(0);
    h.manager.update(id, { title: "Cleanup finished", type: "success", timeout: 8_000, data });
    expect(h.open.get(id)).toMatchObject({ title: "Cleanup finished", timeout: 8_000 });
  });

  it("shows a persistent warning's timed outcome during the cool-down", () => {
    const h = createHarness();
    const data = { conditionKey: "thread-retention-progress:run-2" };
    const id = h.manager.add({ title: "Cleanup: 1 kept", type: "warning", timeout: 0, data });
    h.userDismiss(id);
    h.manager.update(id, { title: "Cleanup: 2 kept", type: "warning", timeout: 0, data });
    expect(h.open.size).toBe(0);
    h.manager.add({ id, title: "Cleanup finished", type: "success", timeout: 8_000, data });
    expect(h.open.get(id)?.title).toBe("Cleanup finished");
  });

  it("does not suppress a condition its owner closed", () => {
    const h = createHarness();
    h.manager.close(h.manager.add(slow("2 requests")));
    expect(h.open.has(h.manager.add(slow("1 request")))).toBe(true);
  });

  it("applies the final state's duration when a timed progress toast settles", () => {
    const h = createHarness();
    const id = h.manager.add({ title: "Pulling…", type: "loading" });
    h.manager.update(id, { title: "Pull failed", type: "error" });
    expect(h.open.get(id)?.timeout).toBe(15_000);
    h.manager.update(id, { title: "Pulled", type: "success", timeout: 2_000 });
    expect(h.open.get(id)?.timeout).toBe(5_000);
  });

  it("delivers the outcome of a dismissed progress toast", () => {
    const h = createHarness();
    const id = h.manager.add({ title: "Pushing…", type: "loading", timeout: 0 });
    h.userDismiss(id);
    h.manager.update(id, { title: "Still pushing…", type: "loading" });
    expect(h.open.has(id)).toBe(false);
    h.manager.update(id, { title: "Push failed", type: "error" });
    expect(h.open.get(id)).toMatchObject({ title: "Push failed", type: "error", timeout: 0 });
    // Persistent toasts hand their (error) duration to the visible-time countdown.
  });

  it("does not resurrect plain toasts or toasts closed by their owner", () => {
    const h = createHarness();
    const plain = h.manager.add({ title: "Saved", type: "success" });
    h.userDismiss(plain);
    h.manager.update(plain, { title: "Saved again", type: "success" });
    const owned = h.manager.add({ title: "Working", type: "loading" });
    h.manager.close(owned);
    h.manager.update(owned, { title: "Done", type: "success" });
    expect(h.open.size).toBe(0);
  });

  it("runs promise toasts through the policy", async () => {
    const h = createHarness();
    const result = h.manager.promise(Promise.resolve(3), {
      loading: { title: "Pulling…" },
      success: (value: number) => `Pulled ${value}`,
      error: "Pull failed",
    });
    const [id] = [...h.open.keys()];
    expect(h.open.get(id!)?.type).toBe("loading");
    h.userDismiss(id!);
    await expect(result).resolves.toBe(3);
    expect(h.open.get(id!)).toMatchObject({ type: "success", description: "Pulled 3" });
    expect(h.shows).toEqual(["promise", "resurface"]);
  });

  it("rejects like Base UI and shows the error outcome", async () => {
    const h = createHarness();
    const failure = new Error("boom");
    const result = h.manager.promise(Promise.reject(failure), {
      loading: "Fetching…",
      success: "Fetched",
      error: (error: Error) => ({ title: "Fetch failed", description: error.message }),
    });
    await expect(result).rejects.toBe(failure);
    expect([...h.open.values()][0]).toMatchObject({ type: "error", description: "boom" });
  });
});
