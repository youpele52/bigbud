import "~/index.css";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { ToastProvider, toastManager } from "./toast";

const route = vi.hoisted(() => ({ current: null as string | null }));
vi.mock("@tanstack/react-router", () => ({ useParams: () => route.current }));

afterEach(() => {
  toastManager.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  route.current = null;
});

it("keeps loading persistent, preserves updates, and resumes ordinary timers after hover", async () => {
  const screen = await render(<ToastProvider />);
  try {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const closed = vi.fn();
    const id = toastManager.add({
      title: "Working",
      type: "loading",
      timeout: 50,
      onClose: closed,
    });
    await expect.element(screen.getByText("Working")).toBeVisible();
    await vi.advanceTimersByTimeAsync(500);
    expect(closed).not.toHaveBeenCalled();
    toastManager.update(id, { type: "success", title: "Done", timeout: 200 });
    await expect.element(screen.getByText("Done")).toBeVisible();
    const viewport = document.querySelector('[data-slot="toast-viewport"]')!;
    viewport.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(closed).not.toHaveBeenCalled();
    viewport.dispatchEvent(
      new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }),
    );
    await vi.advanceTimersByTimeAsync(199);
    expect(closed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(closed).toHaveBeenCalledOnce();
  } finally {
    await screen.unmount();
  }
});

it("preserves the recovered toast visible-time budget across blur and thread unmounts", async () => {
  route.current = "active";
  const screen = await render(<ToastProvider />);
  try {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const closed = vi.fn();
    toastManager.add({
      title: "Reconnected",
      type: "success",
      timeout: 0,
      onClose: closed,
      data: { threadId: ThreadId.makeUnsafe("active"), dismissAfterVisibleMs: 1000 },
    });
    await expect.element(screen.getByText("Reconnected")).toBeVisible();
    await vi.advanceTimersByTimeAsync(300);
    focus.mockReturnValue(false);
    window.dispatchEvent(new Event("blur"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(closed).not.toHaveBeenCalled();
    focus.mockReturnValue(true);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(200);
    route.current = "other";
    await screen.rerender(<ToastProvider position="top-left" />);
    await vi.advanceTimersByTimeAsync(5000);
    expect(closed).not.toHaveBeenCalled();
    route.current = "active";
    await screen.rerender(<ToastProvider />);
    await expect.element(screen.getByText("Reconnected")).toBeVisible();
    await vi.advanceTimersByTimeAsync(499);
    expect(closed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(closed).toHaveBeenCalledOnce();
  } finally {
    await screen.unmount();
  }
});

it("still times out overflow and hidden-thread cards instead of restarting their budgets on reveal", async () => {
  const screen = await render(<ToastProvider />);
  try {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const queuedClosed = vi.fn();
    const queuedRemoved = vi.fn();
    const hiddenClosed = vi.fn();
    const hiddenRemoved = vi.fn();
    toastManager.add({
      title: "Queued timer",
      timeout: 500,
      onClose: queuedClosed,
      onRemove: queuedRemoved,
    });
    for (let i = 0; i < 5; i++)
      toastManager.add({ title: `Persistent ${i}`, type: "loading", timeout: 50 });
    toastManager.add({
      title: "Hidden timer",
      timeout: 250,
      onClose: hiddenClosed,
      onRemove: hiddenRemoved,
      data: { threadId: ThreadId.makeUnsafe("other") },
    });
    await expect.element(screen.getByText("Persistent 4")).toBeVisible();
    const queued = screen
      .getByText("Queued timer")
      .element()
      .closest<HTMLElement>('[data-slot="toast-popup"]')!;
    expect(queued.inert).toBe(true);
    await vi.advanceTimersByTimeAsync(249);
    expect(hiddenClosed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(hiddenClosed).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(249);
    expect(queuedClosed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(queuedClosed).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    await expect.poll(() => hiddenRemoved.mock.calls.length).toBe(1);
    await expect.poll(() => queuedRemoved.mock.calls.length).toBe(1);
    expect(
      document.querySelectorAll('[data-type="loading"][data-slot="toast-popup"]'),
    ).toHaveLength(5);
  } finally {
    await screen.unmount();
  }
});
