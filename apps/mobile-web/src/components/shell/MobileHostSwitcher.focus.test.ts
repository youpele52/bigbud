import { describe, expect, it, vi } from "vitest";
import { createMobileHostFocusReturn } from "./MobileHostSwitcher.focus";

function fixture() {
  let focused = "body";
  const queued = new Map<number, () => void>();
  let next = 0;
  const restore = vi.fn(() => {
    focused = "trigger";
  });
  const owner = createMobileHostFocusReturn({
    requestFrame(callback) {
      queued.set(++next, callback);
      return next;
    },
    cancelFrame(handle) {
      queued.delete(handle);
    },
    canRestore: () => focused === "body",
    restore,
  });
  function dequeue() {
    const entry = queued.entries().next().value;
    if (!entry) throw new Error("Expected a queued browser frame");
    queued.delete(entry[0]);
    return entry[1];
  }
  return {
    owner,
    restore,
    dequeue,
    focus: (target: string) => {
      focused = target;
    },
  };
}

describe("host menu delayed focus ownership", () => {
  it("preserves a deliberate outside target selected after dismissal", () => {
    const view = fixture();
    view.owner.schedule();
    const browserCallback = view.dequeue();
    view.focus("outside-button");
    browserCallback();
    expect(view.restore).not.toHaveBeenCalled();
  });

  it("fences an already-dequeued close callback across reopening and a later close", () => {
    const view = fixture();
    view.owner.schedule();
    const firstClose = view.dequeue();
    view.owner.cancel(); // Reopen before that callback executes.
    view.owner.schedule();
    const secondClose = view.dequeue();
    firstClose();
    expect(view.restore).not.toHaveBeenCalled();
    secondClose();
    expect(view.restore).toHaveBeenCalledExactlyOnceWith();
  });

  it("fences an already-dequeued callback on unmount and remains usable after effect replay", () => {
    const view = fixture();
    view.owner.schedule();
    const retiredCallback = view.dequeue();
    view.owner.cancel();
    retiredCallback();
    expect(view.restore).not.toHaveBeenCalled();
    view.owner.schedule(); // StrictMode can set the same owner up again.
    view.dequeue()();
    expect(view.restore).toHaveBeenCalledExactlyOnceWith();
  });
});
