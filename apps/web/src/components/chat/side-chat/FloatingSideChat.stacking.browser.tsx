import "../../../index.css";

import { ThreadId } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

vi.mock("~/rpc/nativeApi", () => ({
  ensureNativeApi: () => ({}),
  readNativeApi: () => undefined,
}));
// The sidecar's conversation needs a live thread; only its panel stacking is under test here.
vi.mock("~/components/chat/view/ThreadComposerSurface", () => ({
  ThreadComposerSurface: () => null,
}));

import { CHAT_FLOATING_PANEL_STAGGER_PX } from "../common/chatFloatingPanel.layout";
import { useChatFloatingPanelOrderStore } from "../common/chatFloatingPanel.order";
import { FloatingPlanCardLayer } from "../plan/FloatingPlanCardLayer";
import { FloatingSideChat } from "./FloatingSideChat";

/** Mirrors ChatViewChatBody: Tasks in the messages anchor, Sidecar mounted after the composer. */
function StackingHarness(props: { showSidecar: boolean; showTasks: boolean }) {
  return (
    <div className="relative flex h-[640px] w-[960px] min-h-0 flex-col" data-chat-view-root>
      <header className="h-12 shrink-0" />
      <div className="relative flex min-h-0 flex-1 flex-col" data-chat-floating-panel-anchor>
        {props.showTasks ? (
          <FloatingPlanCardLayer
            activePlan={{
              createdAt: "2026-11-21T00:00:00.000Z",
              turnId: null,
              steps: [{ step: "Ship it", status: "completed" }],
            }}
            activeProposedPlan={null}
            label="Tasks"
            markdownCwd={undefined}
            workspaceRoot={undefined}
            timestampFormat="locale"
            onClose={() => undefined}
          />
        ) : null}
      </div>
      <form data-chat-composer-form="true" className="h-28 shrink-0" />
      {props.showSidecar ? (
        <FloatingSideChat
          mainThreadId={ThreadId.makeUnsafe("stacking-main")}
          messageCount={0}
          onFocusMainComposer={() => undefined}
          threadId={ThreadId.makeUnsafe("stacking-sidecar")}
          workspaceRoot={undefined}
        />
      ) : null}
    </div>
  );
}

function panel(id: "tasks" | "sidecar"): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-chat-floating-panel="${id}"]`);
  expect(element, id).not.toBeNull();
  return element!;
}

function panelAt(x: number, y: number): string | undefined {
  const hit = document.elementFromPoint(x, y);
  return hit?.closest<HTMLElement>("[data-chat-floating-panel]")?.dataset.chatFloatingPanel;
}

function tasksCardRect(): DOMRect {
  return panel("tasks").firstElementChild!.getBoundingClientRect();
}

/** The panel hit near the bottom of the Tasks card, below the stagger, where both panels overlap. */
function topmostPanelOverTasks(): string | undefined {
  const tasksCard = tasksCardRect();
  expect(tasksCard.height).toBeGreaterThan(CHAT_FLOATING_PANEL_STAGGER_PX + 16);
  return panelAt(tasksCard.left + tasksCard.width / 2, tasksCard.bottom - 8);
}

/** The Sidecar sits one stagger below and left of the Tasks card's top-right corner. */
function expectSidecarStaggered(staggered: boolean) {
  const offset = staggered ? CHAT_FLOATING_PANEL_STAGGER_PX : 0;
  const tasksCard = tasksCardRect();
  const sidecar = panel("sidecar").getBoundingClientRect();
  expect(Math.abs(sidecar.top - tasksCard.top - offset)).toBeLessThanOrEqual(1);
  expect(Math.abs(tasksCard.right - sidecar.right - offset)).toBeLessThanOrEqual(1);
}

describe("floating panel stacking", () => {
  beforeEach(async () => {
    useChatFloatingPanelOrderStore.setState({ order: [] });
    await page.viewport(1280, 800);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("puts the Sidecar on top when it opens after Tasks", async () => {
    const mounted = await render(<StackingHarness showTasks showSidecar={false} />);
    try {
      await mounted.rerender(<StackingHarness showTasks showSidecar />);
      await vi.waitFor(() => expect(topmostPanelOverTasks()).toBe("sidecar"));
      expect(Number(panel("sidecar").style.zIndex)).toBeGreaterThan(
        Number(panel("tasks").style.zIndex),
      );
    } finally {
      await mounted.unmount();
    }
  });

  it("puts Tasks on top when it opens after the Sidecar", async () => {
    const mounted = await render(<StackingHarness showTasks={false} showSidecar />);
    try {
      await mounted.rerender(<StackingHarness showTasks showSidecar />);
      await vi.waitFor(() => expect(topmostPanelOverTasks()).toBe("tasks"));
    } finally {
      await mounted.unmount();
    }
  });

  it("brings the lower panel to the front on pointer-down inside it", async () => {
    const mounted = await render(<StackingHarness showTasks={false} showSidecar />);
    try {
      await mounted.rerender(<StackingHarness showTasks showSidecar />);
      await vi.waitFor(() => expect(topmostPanelOverTasks()).toBe("tasks"));

      // Press the part of the Sidecar that Tasks does not cover.
      const sidecar = panel("sidecar").getBoundingClientRect();
      const target = document.elementFromPoint(sidecar.left + 24, sidecar.bottom - 24)!;
      expect(target.closest("[data-chat-floating-panel]")).toBe(panel("sidecar"));
      target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));

      await vi.waitFor(() => expect(topmostPanelOverTasks()).toBe("sidecar"));
    } finally {
      await mounted.unmount();
    }
  });

  it("brings a panel to the front when focus moves inside it", async () => {
    const mounted = await render(<StackingHarness showTasks showSidecar={false} />);
    try {
      await mounted.rerender(<StackingHarness showTasks showSidecar />);
      await vi.waitFor(() => expect(topmostPanelOverTasks()).toBe("sidecar"));

      panel("tasks").querySelector<HTMLElement>("button")!.focus();

      await vi.waitFor(() => expect(topmostPanelOverTasks()).toBe("tasks"));
    } finally {
      await mounted.unmount();
    }
  });
  it("staggers the Sidecar on top so Tasks keeps a clickable top edge", async () => {
    const mounted = await render(<StackingHarness showTasks showSidecar={false} />);
    try {
      await mounted.rerender(<StackingHarness showTasks showSidecar />);
      await vi.waitFor(() => expect(topmostPanelOverTasks()).toBe("sidecar"));
      expectSidecarStaggered(true);

      // The strip of Tasks above the staggered Sidecar is exposed and raises Tasks when pressed.
      const tasksCard = tasksCardRect();
      const x = tasksCard.left + tasksCard.width / 2;
      const y = tasksCard.top + CHAT_FLOATING_PANEL_STAGGER_PX / 2;
      expect(panelAt(x, y)).toBe("tasks");
      document
        .elementFromPoint(x, y)!
        .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));

      await vi.waitFor(() => expect(topmostPanelOverTasks()).toBe("tasks"));
      // Bringing a panel forward never moves either panel.
      expectSidecarStaggered(true);
    } finally {
      await mounted.unmount();
    }
  });

  it("staggers the Sidecar beneath Tasks and restores it when Tasks closes", async () => {
    const mounted = await render(<StackingHarness showTasks={false} showSidecar />);
    try {
      await vi.waitFor(() => expect(panel("sidecar").style.zIndex).toBe("30"));
      const unstaggered = panel("sidecar").getBoundingClientRect();

      await mounted.rerender(<StackingHarness showTasks showSidecar />);
      await vi.waitFor(() => expect(topmostPanelOverTasks()).toBe("tasks"));
      expectSidecarStaggered(true);
      const staggered = panel("sidecar").getBoundingClientRect();
      // Shrinks by the stagger so its bottom stays above the composer.
      expect(Math.abs(staggered.bottom - unstaggered.bottom)).toBeLessThanOrEqual(1);
      expect(
        Math.abs(unstaggered.height - staggered.height - CHAT_FLOATING_PANEL_STAGGER_PX),
      ).toBeLessThanOrEqual(1);

      await mounted.rerender(<StackingHarness showTasks={false} showSidecar />);
      await vi.waitFor(() => {
        const restored = panel("sidecar").getBoundingClientRect();
        expect(Math.abs(restored.top - unstaggered.top)).toBeLessThanOrEqual(1);
        expect(Math.abs(restored.right - unstaggered.right)).toBeLessThanOrEqual(1);
      });
    } finally {
      await mounted.unmount();
    }
  });
});
