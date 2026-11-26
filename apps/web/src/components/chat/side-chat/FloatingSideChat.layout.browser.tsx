import "../../../index.css";

import { ThreadId } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

// The sidecar's conversation needs a live thread; only its panel placement is under test here.
vi.mock("~/components/chat/view/ThreadComposerSurface", () => ({
  ThreadComposerSurface: () => null,
}));

import { TASKS_FLOATING_PANEL_POSITION_CLASS_NAME } from "../common/chatFloatingPanel.layout";
import { FloatingSideChat } from "./FloatingSideChat";

/** Mirrors ChatViewContent/ChatViewChatBody: header, banner, messages anchor, composer, toolbar. */
function ChatLayoutHarness(props: { bannerHeight: number }) {
  return (
    <div className="relative flex h-[640px] w-[960px] min-h-0 min-w-0 flex-col" data-chat-view-root>
      <header data-testid="chat-header" className="h-12 shrink-0" />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-chat-body>
        <div style={{ height: props.bannerHeight }} className="shrink-0" />
        <div className="relative flex min-h-0 flex-1 flex-col" data-chat-floating-panel-anchor>
          <div className={TASKS_FLOATING_PANEL_POSITION_CLASS_NAME}>
            <div
              data-testid="tasks-panel"
              className="pointer-events-auto h-40 w-full sm:w-[22rem]"
            />
          </div>
        </div>
        <div className="px-3 pt-1.5 pb-1">
          <form data-chat-composer-form="true" className="h-28" />
        </div>
        <FloatingSideChat
          mainThreadId={ThreadId.makeUnsafe("layout-main")}
          messageCount={0}
          onFocusMainComposer={() => undefined}
          threadId={ThreadId.makeUnsafe("layout-sidecar")}
          workspaceRoot={undefined}
        />
        <div data-testid="branch-toolbar" className="h-10 shrink-0" />
      </div>
    </div>
  );
}

function rectOf(selector: string): DOMRect {
  const element = document.querySelector<HTMLElement>(selector);
  expect(element, selector).not.toBeNull();
  return element!.getBoundingClientRect();
}

describe("FloatingSideChat layout", () => {
  afterEach(async () => {
    document.body.innerHTML = "";
    await page.viewport(1280, 800);
  });

  for (const bannerHeight of [0, 56]) {
    it(`top-aligns with the Tasks panel and stops above the composer (banner ${bannerHeight}px)`, async () => {
      await page.viewport(1280, 800);
      const mounted = await render(<ChatLayoutHarness bannerHeight={bannerHeight} />);
      try {
        await vi.waitFor(() => {
          const sidecar = rectOf("[data-chat-focus-scope]");
          const tasks = rectOf('[data-testid="tasks-panel"]');
          const header = rectOf('[data-testid="chat-header"]');
          const composer = rectOf("[data-chat-composer-form]");

          expect(Math.abs(sidecar.top - tasks.top)).toBeLessThanOrEqual(1);
          expect(sidecar.top).toBeGreaterThan(header.bottom);
          expect(Math.abs(composer.top - sidecar.bottom - 12)).toBeLessThanOrEqual(1);
          expect(sidecar.height).toBeGreaterThan(0);
        });
      } finally {
        await mounted.unmount();
      }
    });
  }

  it("keeps a manual resize anchored at the top", async () => {
    await page.viewport(1280, 800);
    const mounted = await render(<ChatLayoutHarness bannerHeight={0} />);
    try {
      const panel = document.querySelector<HTMLElement>("[data-chat-focus-scope]")!;
      await vi.waitFor(() => expect(panel.getBoundingClientRect().height).toBeGreaterThan(200));
      const topBefore = panel.getBoundingClientRect().top;
      // `resize: vertical` writes an inline height; emulate the user shrinking the panel.
      panel.style.height = "200px";
      const resized = panel.getBoundingClientRect();
      expect(resized.height).toBe(200);
      expect(Math.abs(resized.top - topBefore)).toBeLessThanOrEqual(1);
    } finally {
      await mounted.unmount();
    }
  });

  it("clears its layout variables when it unmounts", async () => {
    const mounted = await render(<ChatLayoutHarness bannerHeight={0} />);
    const root = document.querySelector<HTMLElement>("[data-chat-view-root]")!;
    await vi.waitFor(() => expect(root.style.getPropertyValue("--side-chat-top")).not.toBe(""));
    await mounted.unmount();
    expect(root.style.getPropertyValue("--side-chat-top")).toBe("");
  });
});
