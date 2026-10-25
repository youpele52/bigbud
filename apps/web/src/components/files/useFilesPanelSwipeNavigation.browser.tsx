import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useRef } from "react";

import { useFilesPanelSwipeNavigation } from "./useFilesPanelSwipeNavigation";

function Harness(props: {
  canNavigate: (direction: -1 | 1) => boolean;
  navigate: (direction: -1 | 1) => void;
  enabled?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFilesPanelSwipeNavigation(panelRef, props.canNavigate, props.navigate, props.enabled ?? true);
  return (
    <div ref={panelRef} id="panel" style={{ width: 400, height: 300 }}>
      <div id="plain" style={{ height: 100 }}>
        Preview
      </div>
      <div id="scroller" style={{ width: 200, overflowX: "auto" }}>
        <div style={{ width: 800, height: 40 }}>Long code line</div>
      </div>
      <input id="search" />
    </div>
  );
}

let now = 0;
const target = (id: string) => document.getElementById(id)!;

async function wheel(id: string, deltaX: number, init: WheelEventInit & { gap?: number } = {}) {
  now += init.gap ?? 16;
  target(id).dispatchEvent(
    new WheelEvent("wheel", { deltaX, bubbles: true, composed: true, cancelable: true, ...init }),
  );
  await Promise.resolve();
}

/** A real trackpad flick: finger movement, then momentum that outlasts the recognition window. */
async function flick(id: string, direction: -1 | 1, init: WheelEventInit = {}) {
  await wheel(id, 30 * direction, { ...init, gap: 400 });
  for (let index = 0; index < 9; index += 1) await wheel(id, 30 * direction, init);
  for (let delta = 30; delta > 0.5; delta *= 0.95) await wheel(id, delta * direction, init);
}

async function mount(enabled = true, canNavigate = () => true) {
  const navigate = vi.fn();
  const screen = await render(
    <Harness canNavigate={canNavigate} navigate={navigate} enabled={enabled} />,
  );
  return { navigate, screen };
}

describe("files panel two-finger history swipe", () => {
  beforeEach(() => {
    now = 10_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
  });
  afterEach(() => vi.restoreAllMocks());

  it("steps once per flick even though momentum keeps scrolling", async () => {
    const { navigate, screen } = await mount();
    try {
      await flick("plain", -1);
      expect(navigate.mock.calls).toEqual([[-1]]);
      now += 1300;
      await flick("plain", 1);
      expect(navigate.mock.calls).toEqual([[-1], [1]]);
    } finally {
      await screen.unmount();
    }
  });

  it("holds a cooldown after a step and ignores a vertical scroll turning sideways", async () => {
    const { navigate, screen } = await mount();
    try {
      // A short swipe without momentum, then a new swipe right after the quiet period.
      await wheel("plain", -60, { gap: 400 });
      await wheel("plain", -60);
      await wheel("plain", -60);
      expect(navigate).toHaveBeenCalledOnce();
      await wheel("plain", -60, { gap: 300 });
      await wheel("plain", -60);
      await wheel("plain", -60);
      expect(navigate).toHaveBeenCalledOnce();
      await wheel("plain", -60, { gap: 1200 });
      await wheel("plain", -60);
      await wheel("plain", -60);
      expect(navigate).toHaveBeenCalledTimes(2);
      now += 2000;
      await wheel("plain", 0, { deltaY: 40, gap: 400 });
      for (let index = 0; index < 6; index += 1) await wheel("plain", -60);
      expect(navigate).toHaveBeenCalledTimes(2);
    } finally {
      await screen.unmount();
    }
  });

  it("lets a sideways scroller keep the swipe unless it is already at that edge", async () => {
    const { navigate, screen } = await mount();
    try {
      const scroller = target("scroller");
      scroller.scrollLeft = 200;
      await flick("scroller", -1);
      expect(navigate).not.toHaveBeenCalled();
      scroller.scrollLeft = 0;
      now += 2000;
      await flick("scroller", 1);
      expect(navigate).not.toHaveBeenCalled();
      now += 2000;
      await flick("scroller", -1);
      expect(navigate.mock.calls).toEqual([[-1]]);
    } finally {
      await screen.unmount();
    }
  });

  it.each([
    ["shift-scroll", "plain", { shiftKey: true }],
    ["pinch-zoom", "plain", { ctrlKey: true }],
    ["text input", "search", {}],
  ] as const)("ignores %s", async (_label, id, init) => {
    const { navigate, screen } = await mount();
    try {
      await flick(id, -1, init);
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("does nothing when disabled, hidden or without history in that direction", async () => {
    const disabled = await mount(false);
    try {
      await flick("plain", -1);
      expect(disabled.navigate).not.toHaveBeenCalled();
    } finally {
      await disabled.screen.unmount();
    }
    const noHistory = await mount(true, () => false);
    try {
      await flick("plain", -1);
      expect(noHistory.navigate).not.toHaveBeenCalled();
      target("panel").setAttribute("inert", "");
      now += 2000;
      await flick("plain", 1);
      expect(noHistory.navigate).not.toHaveBeenCalled();
    } finally {
      await noHistory.screen.unmount();
    }
  });
});
