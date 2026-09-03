import { useCallback, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useTerminalLayout } from "./chat-view/terminalLayout.hooks";

const SPLIT_HEIGHT = 333;

function TerminalLayoutHarness() {
  const [activeThreadId, setActiveThreadId] = useState("thread-a");
  const [terminalOpen, setTerminalOpenState] = useState(false);
  const setTerminalOpen = useCallback((open: boolean) => setTerminalOpenState(open), []);
  const toggleTerminalVisibility = useCallback(() => setTerminalOpenState((open) => !open), []);
  const layout = useTerminalLayout({
    activeThreadId,
    terminalOpen,
    setTerminalOpen,
    toggleTerminalVisibility,
  });

  return (
    <div>
      <button type="button" onClick={layout.openTerminal}>
        Open terminal
      </button>
      <button type="button" onClick={layout.toggleTerminal}>
        Toggle terminal
      </button>
      <button type="button" onClick={() => setActiveThreadId("thread-b")}>
        Change thread
      </button>
      {terminalOpen ? (
        <button aria-label={layout.nextActionLabel} type="button" onClick={layout.cycleLayout}>
          Cycle layout
        </button>
      ) : null}
      <section
        data-chat-region
        hidden={!layout.chatVisible}
        inert={!layout.chatVisible || undefined}
      >
        Chat
      </section>
      <section
        aria-hidden={layout.terminalPresentation === "hidden"}
        data-terminal-region={layout.terminalPresentation}
        hidden={layout.terminalPresentation === "hidden"}
        inert={layout.terminalPresentation === "hidden" || undefined}
        style={
          layout.terminalPresentation === "split" ? { maxHeight: `${SPLIT_HEIGHT}px` } : undefined
        }
      >
        Terminal
        {layout.terminalPresentation === "split" ? <div data-resize-handle /> : null}
      </section>
    </div>
  );
}

function findButton(name: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!button) throw new Error(`Unable to find ${name}.`);
  return button;
}

function findLayoutButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('button[aria-label^="Show "]');
}

describe("terminal layout integration", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("cycles accessible layouts without changing split height or button focus", async () => {
    const screen = await render(<TerminalLayoutHarness />);
    try {
      findButton("Open terminal").click();
      await vi.waitFor(() => expect(findLayoutButton()?.ariaLabel).toBe("Show terminal only"));

      const layoutButton = findLayoutButton()!;
      const chat = document.querySelector<HTMLElement>("[data-chat-region]")!;
      const terminal = document.querySelector<HTMLElement>("[data-terminal-region]")!;
      expect(terminal.dataset.terminalRegion).toBe("split");
      expect(terminal.style.maxHeight).toBe(`${SPLIT_HEIGHT}px`);
      expect(terminal.querySelector("[data-resize-handle]")).toBeTruthy();

      layoutButton.focus();
      layoutButton.click();
      await vi.waitFor(() => {
        expect(layoutButton.ariaLabel).toBe("Show chat only");
        expect(chat.hidden).toBe(true);
        expect(chat.inert).toBe(true);
        expect(terminal.dataset.terminalRegion).toBe("fill");
        expect(terminal.style.maxHeight).toBe("");
        expect(terminal.querySelector("[data-resize-handle]")).toBeNull();
        expect(document.activeElement).toBe(layoutButton);
      });

      layoutButton.click();
      await vi.waitFor(() => {
        expect(layoutButton.ariaLabel).toBe("Show split chat and terminal");
        expect(chat.hidden).toBe(false);
        expect(terminal.hidden).toBe(true);
        expect(terminal.inert).toBe(true);
        expect(document.activeElement).toBe(layoutButton);
      });

      layoutButton.click();
      await vi.waitFor(() => {
        expect(layoutButton.ariaLabel).toBe("Show terminal only");
        expect(terminal.dataset.terminalRegion).toBe("split");
        expect(terminal.style.maxHeight).toBe(`${SPLIT_HEIGHT}px`);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("resets to split on idempotent open, full close/reopen, and thread change", async () => {
    const screen = await render(<TerminalLayoutHarness />);
    try {
      findButton("Open terminal").click();
      await vi.waitFor(() => expect(findLayoutButton()).toBeTruthy());
      findLayoutButton()!.click();
      await vi.waitFor(() => expect(findLayoutButton()?.ariaLabel).toBe("Show chat only"));
      findLayoutButton()!.click();
      await vi.waitFor(() =>
        expect(findLayoutButton()?.ariaLabel).toBe("Show split chat and terminal"),
      );

      findButton("Open terminal").click();
      await vi.waitFor(() => expect(findLayoutButton()?.ariaLabel).toBe("Show terminal only"));

      findLayoutButton()!.click();
      findButton("Toggle terminal").click();
      await vi.waitFor(() => expect(findLayoutButton()).toBeNull());
      findButton("Toggle terminal").click();
      await vi.waitFor(() => expect(findLayoutButton()?.ariaLabel).toBe("Show terminal only"));

      findLayoutButton()!.click();
      findButton("Change thread").click();
      await vi.waitFor(() => expect(findLayoutButton()?.ariaLabel).toBe("Show terminal only"));
    } finally {
      await screen.unmount();
    }
  });
});
