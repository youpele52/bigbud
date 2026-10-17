import "../../../index.css";
import { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";

import { ChatLayoutMenu } from "../common/ChatHeader.layoutMenu";
import { ThreadTerminalDrawerToolbar } from "../../terminal/ThreadTerminalDrawerToolbar";
import { useTerminalLayout } from "./chat-view/terminalLayout.hooks";
import { resetTerminalStore } from "../../../stores/terminal/terminal.store.test.helpers";

const SPLIT_HEIGHT = 333;
const openRequests = vi.fn();
const toolbarCases = [
  { variant: "floating", panel: false },
  { variant: "sidebar", panel: false },
  { variant: "floating", panel: true },
  { variant: "sidebar", panel: true },
] as const;

function TerminalLayoutHarness({
  variant = "floating",
  panel = false,
  initiallyOpen = false,
}: {
  variant?: "floating" | "sidebar";
  panel?: boolean;
  initiallyOpen?: boolean;
}) {
  const [activeThreadId, setActiveThreadId] = useState("thread-a");
  const [openByThreadId, setOpenByThreadId] = useState<Record<string, boolean>>({});
  const terminalOpen = openByThreadId[activeThreadId] ?? initiallyOpen;
  const setTerminalOpen = useCallback(
    (open: boolean) => {
      openRequests(open);
      setOpenByThreadId((previous) => ({ ...previous, [activeThreadId]: open }));
    },
    [activeThreadId],
  );
  const toggleTerminalVisibility = useCallback(() => {
    setOpenByThreadId((previous) => ({
      ...previous,
      [activeThreadId]: !(previous[activeThreadId] ?? initiallyOpen),
    }));
  }, [activeThreadId, initiallyOpen]);
  const layout = useTerminalLayout({
    activeThreadId,
    terminalOpen,
    setTerminalOpen,
    toggleTerminalVisibility,
  });
  const terminalVisible = terminalOpen && layout.terminalPresentation !== "hidden";

  return (
    <div>
      <header>
        <ChatLayoutMenu mode={layout.mode} onSelectLayout={layout.selectLayout} />
        <button type="button" onClick={layout.openTerminal}>
          Open terminal
        </button>
        <button type="button" onClick={layout.toggleTerminal}>
          Toggle terminal
        </button>
        <button
          type="button"
          onClick={() => setActiveThreadId((id) => (id === "thread-a" ? "thread-b" : "thread-a"))}
        >
          Change thread
        </button>
      </header>
      <section
        data-chat-region
        hidden={!layout.chatVisible}
        inert={!layout.chatVisible || undefined}
      >
        <div data-chat-scroll style={{ height: 60, overflow: "auto" }}>
          <div style={{ height: 600 }}>Chat</div>
        </div>
        <textarea aria-label="Chat draft" defaultValue="Unsent message" />
      </section>
      <section
        aria-hidden={!terminalVisible}
        data-terminal-region={layout.terminalPresentation}
        data-terminal-open={terminalOpen}
        hidden={!terminalVisible}
        inert={!terminalVisible || undefined}
        style={
          layout.terminalPresentation === "split" ? { maxHeight: `${SPLIT_HEIGHT}px` } : undefined
        }
      >
        Terminal output
        {layout.terminalPresentation === "split" ? <div data-resize-handle /> : null}
        <ThreadTerminalDrawerToolbar
          variant={variant}
          expanded={layout.mode === "terminal-only"}
          onToggleExpanded={panel ? undefined : layout.toggleExpanded}
          hasReachedSplitLimit={false}
          renameTerminalActionLabel="Rename Terminal"
          splitTerminalActionLabel="Split Terminal"
          newTerminalActionLabel="New Terminal"
          closeTerminalActionLabel="Close Terminal"
          resolvedActiveTerminalId="terminal-1"
          onRenameTerminalAction={() => undefined}
          onSplitTerminalAction={() => undefined}
          onNewTerminalAction={() => undefined}
          onCloseTerminal={() => undefined}
        />
      </section>
    </div>
  );
}

function terminalRegion() {
  return document.querySelector<HTMLElement>("[data-terminal-region]")!;
}

async function showMenu(currentLabel: string) {
  await page.getByRole("button", { name: "Chat layout", exact: true }).click();
  await vi.waitFor(() => {
    const current = Array.from(document.querySelectorAll('[role="menuitemradio"]')).find(
      (item) => item.textContent?.trim() === currentLabel,
    );
    expect(current?.getAttribute("aria-checked")).toBe("true");
  });
}

async function selectLayout(label: string, currentLabel: string) {
  await showMenu(currentLabel);
  await page.getByRole("menuitemradio", { name: label, exact: true }).click();
  await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
}

describe("terminal layout integration", () => {
  beforeEach(() => {
    openRequests.mockClear();
    resetTerminalStore();
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("leaves a closed terminal untouched when selecting Chat only", async () => {
    const screen = await render(<TerminalLayoutHarness />);
    try {
      await selectLayout("Chat only", "Chat only");
      expect(openRequests).not.toHaveBeenCalled();
      expect(terminalRegion().dataset.terminalOpen).toBe("false");
      expect(terminalRegion().hidden).toBe(true);
    } finally {
      await screen.unmount();
    }
  });

  it.each(["Chat + terminal", "Terminal only"])(
    "opens a closed terminal directly into %s without spawning on menu open",
    async (label) => {
      const screen = await render(<TerminalLayoutHarness />);
      try {
        expect(terminalRegion().hidden).toBe(true);
        await showMenu("Chat only");
        expect(openRequests).not.toHaveBeenCalled();
        await page.getByRole("menuitemradio", { name: label, exact: true }).click();
        await vi.waitFor(() =>
          expect(terminalRegion().dataset.terminalRegion).toBe(
            label === "Terminal only" ? "fill" : "split",
          ),
        );
        expect(openRequests).toHaveBeenCalledExactlyOnceWith(true);
        await selectLayout("Chat only", label);
        expect(terminalRegion().hidden).toBe(true);
        expect(terminalRegion().dataset.terminalOpen).toBe("true");
        await selectLayout(label, "Chat only");
        expect(openRequests).toHaveBeenCalledTimes(1);
      } finally {
        await screen.unmount();
      }
    },
  );

  it.each(["floating", "sidebar"] as const)(
    "shares header selection and %s maximize/restore without losing chat state or split height",
    async (variant) => {
      const screen = await render(<TerminalLayoutHarness variant={variant} />);
      try {
        const scroll = document.querySelector<HTMLElement>("[data-chat-scroll]")!;
        const draft = document.querySelector<HTMLTextAreaElement>("textarea")!;
        scroll.scrollTop = 120;
        await selectLayout("Chat + terminal", "Chat only");
        expect(terminalRegion().style.maxHeight).toBe(`${SPLIT_HEIGHT}px`);
        const expand = document.querySelector<HTMLButtonElement>(
          'button[aria-label="Expand terminal"]',
        )!;
        await page.getByRole("button", { name: "Expand terminal", exact: true }).click();
        await vi.waitFor(() => {
          expect(document.querySelector<HTMLElement>("[data-chat-region]")!.hidden).toBe(true);
          expect(document.querySelector<HTMLElement>("[data-chat-region]")!.inert).toBe(true);
          expect(terminalRegion().dataset.terminalRegion).toBe("fill");
          expect(terminalRegion().style.maxHeight).toBe("");
          expect(terminalRegion().querySelector("[data-resize-handle]")).toBeNull();
          expect(expand.ariaLabel).toBe("Restore split view");
          expect(document.activeElement).toBe(expand);
        });
        await showMenu("Terminal only");
        await userEvent.keyboard("{Escape}");
        await page.getByRole("button", { name: "Restore split view", exact: true }).click();
        await vi.waitFor(() => expect(terminalRegion().dataset.terminalRegion).toBe("split"));
        expect(terminalRegion().style.maxHeight).toBe(`${SPLIT_HEIGHT}px`);
        expect(terminalRegion().querySelector("[data-resize-handle]")).toBeTruthy();
        expect(scroll.scrollTop).toBe(120);
        expect(draft.value).toBe("Unsent message");
        await selectLayout("Terminal only", "Chat + terminal");
        await expect
          .element(page.getByRole("button", { name: "Restore split view", exact: true }))
          .toBeVisible();
        await selectLayout("Chat only", "Terminal only");
        expect(scroll.scrollTop).toBe(120);
        expect(draft.value).toBe("Unsent message");
        expect(terminalRegion().inert).toBe(true);
        expect(openRequests).toHaveBeenCalledTimes(1);
      } finally {
        await screen.unmount();
      }
    },
  );

  it("resets on idempotent open and close/reopen, but remembers each thread", async () => {
    const screen = await render(<TerminalLayoutHarness />);
    try {
      await selectLayout("Terminal only", "Chat only");
      await page.getByRole("button", { name: "Open terminal", exact: true }).click();
      await vi.waitFor(() => expect(terminalRegion().dataset.terminalRegion).toBe("split"));
      await selectLayout("Chat only", "Chat + terminal");
      await page.getByRole("button", { name: "Toggle terminal", exact: true }).click();
      await vi.waitFor(() => expect(terminalRegion().dataset.terminalOpen).toBe("false"));
      await showMenu("Chat only");
      await userEvent.keyboard("{Escape}");
      await page.getByRole("button", { name: "Toggle terminal", exact: true }).click();
      await vi.waitFor(() => expect(terminalRegion().dataset.terminalRegion).toBe("split"));
      await selectLayout("Terminal only", "Chat + terminal");
      await page.getByRole("button", { name: "Change thread", exact: true }).click();
      await vi.waitFor(() => expect(terminalRegion().dataset.terminalOpen).toBe("false"));
      await page.getByRole("button", { name: "Change thread", exact: true }).click();
      await vi.waitFor(() => expect(terminalRegion().dataset.terminalRegion).toBe("fill"));
      await page.getByRole("button", { name: "Change thread", exact: true }).click();
      await page.getByRole("button", { name: "Open terminal", exact: true }).click();
      await vi.waitFor(() => expect(terminalRegion().dataset.terminalRegion).toBe("split"));
      await selectLayout("Chat only", "Chat + terminal");
      await page.getByRole("button", { name: "Change thread", exact: true }).click();
      await vi.waitFor(() => expect(terminalRegion().dataset.terminalRegion).toBe("fill"));
      await page.getByRole("button", { name: "Change thread", exact: true }).click();
      await vi.waitFor(() => expect(terminalRegion().hidden).toBe(true));
      await showMenu("Chat only");
      await userEvent.keyboard("{Escape}");
      await page.getByRole("button", { name: "Toggle terminal", exact: true }).click();
      await vi.waitFor(() => expect(terminalRegion().dataset.terminalOpen).toBe("false"));
      await selectLayout("Terminal only", "Chat only");
      expect(terminalRegion().dataset.terminalRegion).toBe("fill");
    } finally {
      await screen.unmount();
    }
  });

  it.each(["Terminal only", "Chat only", "Chat + terminal"])(
    "remembers %s after the view unmounts and remounts",
    async (label) => {
      const screen = await render(<TerminalLayoutHarness initiallyOpen />);
      await selectLayout(label, "Chat + terminal");
      await screen.unmount();
      const remounted = await render(<TerminalLayoutHarness initiallyOpen />);
      try {
        await showMenu(label);
        await userEvent.keyboard("{Escape}");
        expect(terminalRegion().dataset.terminalRegion).toBe(
          label === "Terminal only" ? "fill" : label === "Chat only" ? "hidden" : "split",
        );
        expect(openRequests).not.toHaveBeenCalled();
      } finally {
        await remounted.unmount();
      }
    },
  );

  it("supports keyboard selection without opening a session just to show the menu", async () => {
    const screen = await render(<TerminalLayoutHarness />);
    try {
      const trigger = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Chat layout"]',
      )!;
      // Keep the prior test's pointer off the menu while exercising keyboard focus restoration.
      await page.getByRole("button", { name: "Change thread", exact: true }).hover();
      trigger.focus();
      await userEvent.keyboard("{ArrowDown}");
      await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeTruthy());
      expect(openRequests).not.toHaveBeenCalled();
      await userEvent.keyboard("{End}{Enter}");
      await vi.waitFor(() => expect(terminalRegion().dataset.terminalRegion).toBe("fill"));
      await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
    } finally {
      await screen.unmount();
    }
  });

  it.each(toolbarCases)(
    "brightens only the hovered/focused $variant toolbar button, panel=$panel",
    async ({ variant, panel }) => {
      const screen = await render(<TerminalLayoutHarness variant={variant} panel={panel} />);
      try {
        await selectLayout("Chat + terminal", "Chat only");
        const buttons = Array.from(terminalRegion().querySelectorAll<HTMLButtonElement>("button"));
        const colors = buttons.map((button) => getComputedStyle(button).color);
        for (const [index, button] of buttons.entries()) {
          await page.getByRole("button", { name: button.ariaLabel!, exact: true }).hover();
          await vi.waitFor(() => expect(getComputedStyle(button).color).not.toBe(colors[index]));
          const neighborIndex = (index + 1) % buttons.length;
          expect(getComputedStyle(buttons[neighborIndex]!).color).toBe(colors[neighborIndex]);
        }
        await page.getByRole("button", { name: "Open terminal", exact: true }).hover();
        await userEvent.keyboard("{Tab}");
        buttons[0]!.focus();
        expect(buttons[0]!.matches(":focus-visible")).toBe(true);
        await vi.waitFor(() => expect(getComputedStyle(buttons[0]!).color).not.toBe(colors[0]));
      } finally {
        await screen.unmount();
      }
    },
  );

  it.each(toolbarCases)(
    "keeps ordered $variant actions and callbacks, panel=$panel",
    async ({ variant, panel }) => {
      const onNew = vi.fn();
      const onSplit = vi.fn();
      const onRename = vi.fn();
      const onClose = vi.fn();
      const onExpand = vi.fn();
      const screen = await render(
        <ThreadTerminalDrawerToolbar
          variant={variant}
          hasReachedSplitLimit={false}
          renameTerminalActionLabel="Rename Terminal"
          splitTerminalActionLabel="Split Terminal (⌘⇧G)"
          newTerminalActionLabel="New Terminal (⌘N)"
          closeTerminalActionLabel="Close Terminal (⌘W)"
          resolvedActiveTerminalId="terminal-2"
          onRenameTerminalAction={onRename}
          onSplitTerminalAction={onSplit}
          onNewTerminalAction={onNew}
          onCloseTerminal={onClose}
          onToggleExpanded={panel ? undefined : onExpand}
        />,
      );
      try {
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
        expect(buttons.map((button) => button.ariaLabel)).toEqual([
          "New Terminal (⌘N)",
          "Split Terminal (⌘⇧G)",
          "Rename Terminal",
          "Close Terminal (⌘W)",
          ...(!panel ? ["Expand terminal"] : []),
        ]);
        const dividers = document.querySelectorAll("div.w-px");
        expect(dividers).toHaveLength(panel ? 2 : 3);
        expect(dividers[0]!.previousElementSibling).toBe(buttons[0]);
        expect(dividers[0]!.nextElementSibling).toBe(buttons[1]);
        expect(dividers[1]!.previousElementSibling).toBe(buttons[2]);
        expect(dividers[1]!.nextElementSibling).toBe(buttons[3]);
        if (!panel) {
          expect(dividers[2]!.previousElementSibling).toBe(buttons[3]);
          expect(dividers[2]!.nextElementSibling).toBe(buttons[4]);
        }
        const callbacks = [onNew, onSplit, onRename, onClose, ...(!panel ? [onExpand] : [])];
        for (const [index, button] of buttons.entries()) {
          expect(button.querySelector("svg")?.classList.contains("size-3.25")).toBe(true);
          await page.getByRole("button", { name: button.ariaLabel!, exact: true }).click();
          expect(callbacks[index]).toHaveBeenCalledTimes(1);
        }
        expect(onClose).toHaveBeenCalledExactlyOnceWith("terminal-2");
        expect(onExpand).toHaveBeenCalledTimes(panel ? 0 : 1);
      } finally {
        await screen.unmount();
      }
    },
  );
});
