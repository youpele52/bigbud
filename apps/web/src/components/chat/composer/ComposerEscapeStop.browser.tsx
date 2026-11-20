import "../../../index.css";
import type { ReactNode } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useCommandPaletteStore } from "~/stores/ui";

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ESCAPE_STOP_WINDOW_MS } from "./ComposerEscapeStop.logic";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.innerHTML = "";
});

const stopPropagation = (event: KeyboardEvent) => event.stopPropagation();

const keyDown = (key: string) => new KeyboardEvent("keydown", { key, bubbles: true });

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

const visualHint = () => page.getByTestId("composer-escape-stop-hint");

function onWindow(type: "keydown", listener: (event: KeyboardEvent) => void) {
  window.addEventListener(type, listener);
  cleanups.push(() => window.removeEventListener(type, listener));
}

function appendFocusable(parent: Element, element: HTMLElement) {
  parent.append(element);
  element.focus();
}

function stopActions(input: {
  readonly onInterrupt: () => void;
  readonly isRunning?: boolean;
  readonly backgroundSubagentCount?: number;
}) {
  const backgroundSubagentCount = input.backgroundSubagentCount ?? 0;
  return (
    <ComposerPrimaryActions
      compact={false}
      pendingAction={null}
      isRunning={input.isRunning ?? true}
      hasBackgroundWork={backgroundSubagentCount > 0}
      backgroundSubagentCount={backgroundSubagentCount}
      showPlanFollowUpPrompt={false}
      promptHasText={false}
      isSendBusy={false}
      isConnecting={false}
      isPreparingWorktree={false}
      hasSendableContent={false}
      onPreviousPendingQuestion={() => {}}
      onInterrupt={input.onInterrupt}
      onImplementPlanInNewThread={() => {}}
    />
  );
}

function MainScope({ children }: { readonly children: ReactNode }) {
  return (
    <div data-chat-focus-scope="true" data-default-chat-focus-scope="true">
      {children}
    </div>
  );
}

async function renderMain(input: Parameters<typeof stopActions>[0], extra?: ReactNode) {
  await render(
    <MainScope>
      {stopActions(input)}
      {extra}
    </MainScope>,
  );
  return document.querySelector("[data-default-chat-focus-scope]")!;
}

it("stops on a quick double Escape and announces the hint after the first press", async () => {
  const onInterrupt = vi.fn();
  await renderMain({ onInterrupt });
  await expect.element(page.getByRole("status")).toHaveTextContent("");
  await userEvent.keyboard("{Escape}");
  await expect.element(visualHint()).toBeVisible();
  await expect.element(page.getByRole("status")).toHaveTextContent("Press Esc again to stop");
  expect(onInterrupt).not.toHaveBeenCalled();
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(onInterrupt).toHaveBeenCalledOnce());
  await expect.element(visualHint()).not.toBeInTheDocument();
  await expect.element(page.getByRole("status")).toHaveTextContent("");
});

it("does nothing on a single Escape and hides the hint after the window", async () => {
  const onInterrupt = vi.fn();
  await renderMain({ onInterrupt });
  await userEvent.keyboard("{Escape}");
  await expect.element(visualHint()).toBeVisible();
  await settle(ESCAPE_STOP_WINDOW_MS + 100);
  await expect.element(visualHint()).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await settle();
  expect(onInterrupt).not.toHaveBeenCalled();
});

it("is inactive while no Stop button is shown", async () => {
  const onInterrupt = vi.fn();
  await renderMain({ onInterrupt, isRunning: false });
  await userEvent.keyboard("{Escape}{Escape}");
  await settle();
  expect(onInterrupt).not.toHaveBeenCalled();
});

it("does not count an Escape another handler consumed, whatever its listener order", async () => {
  const onInterrupt = vi.fn();
  await renderMain({ onInterrupt });
  let consumeNext = true;
  // Registered after the hook, like an overlay opened while the turn is running.
  onWindow("keydown", (event) => {
    if (event.key === "Escape" && consumeNext) {
      consumeNext = false;
      event.preventDefault();
    }
  });
  await userEvent.keyboard("{Escape}{Escape}");
  await settle();
  expect(onInterrupt).not.toHaveBeenCalled();
});

it("does not count an Escape stopped before it reaches the window", async () => {
  const onInterrupt = vi.fn();
  await renderMain({ onInterrupt });
  document.addEventListener("keydown", stopPropagation);
  cleanups.push(() => document.removeEventListener("keydown", stopPropagation));
  await userEvent.keyboard("{Escape}{Escape}");
  await settle();
  expect(onInterrupt).not.toHaveBeenCalled();
});

function appendMarked(parent: Element, attribute: string, value: string) {
  const element = document.createElement("div");
  element.setAttribute(attribute, value);
  parent.append(element);
  return element;
}

const excluded: ReadonlyArray<{
  readonly name: string;
  readonly setup: (scope: Element) => void;
  readonly keys?: string;
}> = [
  {
    name: "a composer menu escape layer is open",
    setup: (scope) => appendMarked(scope, "data-escape-layer", "true"),
  },
  {
    name: "the citation toolbar is open",
    setup: () => appendMarked(document.body, "data-chat-cite-toolbar", "true"),
  },
  {
    name: "a dialog is open",
    setup: () => appendMarked(document.body, "data-slot", "dialog-popup"),
  },
  {
    name: "the command palette is open",
    setup: () => {
      useCommandPaletteStore.setState({ open: true });
      cleanups.push(() => useCommandPaletteStore.setState({ open: false }));
    },
  },
  {
    name: "the terminal inside the chat scope is focused",
    setup: (scope) => {
      const terminalInput = document.createElement("textarea");
      terminalInput.className = "xterm-helper-textarea";
      appendFocusable(scope, terminalInput);
    },
  },
  {
    name: "focus is inside a toast it closes",
    setup: () => {
      const toast = appendMarked(document.body, "data-slot", "toast-popup");
      appendFocusable(toast, document.createElement("button"));
    },
  },
  { name: "Escape is modified", setup: () => {}, keys: "{Shift>}{Escape}{Escape}{/Shift}" },
];

it.each(excluded)("ignores Escape while $name", async ({ setup, keys }) => {
  const onInterrupt = vi.fn();
  setup(await renderMain({ onInterrupt }));
  await userEvent.keyboard(keys ?? "{Escape}{Escape}");
  await settle();
  expect(onInterrupt).not.toHaveBeenCalled();
});

it("still stops when a press made inside the window is handled after the hint timer", async () => {
  const onInterrupt = vi.fn();
  await renderMain({ onInterrupt });
  document.body.dispatchEvent(keyDown("Escape"));
  await settle(ESCAPE_STOP_WINDOW_MS - 150);
  // Stamped inside the window but handled late, like input queued behind a long streaming render.
  const second = keyDown("Escape");
  await settle(300);
  await expect.element(visualHint()).not.toBeInTheDocument();
  document.body.dispatchEvent(second);
  await vi.waitFor(() => expect(onInterrupt).toHaveBeenCalledOnce());
});

it("lets another key reset the first press even before that press is judged", async () => {
  const onInterrupt = vi.fn();
  await renderMain({ onInterrupt });
  // Both land in one task, so the other key is handled before the first Escape is judged.
  document.body.dispatchEvent(keyDown("Escape"));
  document.body.dispatchEvent(keyDown("a"));
  await settle(30);
  document.body.dispatchEvent(keyDown("Escape"));
  await settle();
  expect(onInterrupt).not.toHaveBeenCalled();
});

it("ignores Escape typed into an unrelated field but honours fields in the chat scope", async () => {
  const onInterrupt = vi.fn();
  await renderMain({ onInterrupt }, <input aria-label="Composer" />);
  appendFocusable(document.body, document.createElement("input"));
  await userEvent.keyboard("{Escape}{Escape}");
  await settle();
  expect(onInterrupt).not.toHaveBeenCalled();

  await page.getByRole("textbox", { name: "Composer" }).click();
  await userEvent.keyboard("{Escape}{Escape}");
  await vi.waitFor(() => expect(onInterrupt).toHaveBeenCalledOnce());
});

it("ignores auto-repeat and lets other keys and pointer presses reset the first press", async () => {
  const onInterrupt = vi.fn();
  await renderMain({ onInterrupt }, <div>Thread row</div>);
  await userEvent.keyboard("{Escape}");
  document.body.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", repeat: true, bubbles: true }),
  );
  await settle();
  expect(onInterrupt).not.toHaveBeenCalled();
  await userEvent.keyboard("a{Escape}");
  await settle();
  expect(onInterrupt).not.toHaveBeenCalled();
  await settle(ESCAPE_STOP_WINDOW_MS);
  await userEvent.keyboard("{Escape}");
  await page.getByText("Thread row").click();
  await userEvent.keyboard("{Escape}");
  await settle();
  expect(onInterrupt).not.toHaveBeenCalled();
});

it("stops only the composer that owns the keyboard", async () => {
  const mainInterrupt = vi.fn();
  const sideInterrupt = vi.fn();
  await render(
    <>
      <MainScope>{stopActions({ onInterrupt: mainInterrupt })}</MainScope>
      <div data-chat-focus-scope="true">
        {stopActions({ onInterrupt: sideInterrupt })}
        <input aria-label="Side composer" />
      </div>
    </>,
  );
  await userEvent.keyboard("{Escape}{Escape}");
  await vi.waitFor(() => expect(mainInterrupt).toHaveBeenCalledOnce());
  expect(sideInterrupt).not.toHaveBeenCalled();

  await page.getByRole("textbox", { name: "Side composer" }).click();
  await userEvent.keyboard("{Escape}{Escape}");
  await vi.waitFor(() => expect(sideInterrupt).toHaveBeenCalledOnce());
  expect(mainInterrupt).toHaveBeenCalledOnce();
});

it("asks before stopping background subagents, and Escape keeps them running", async () => {
  const onInterrupt = vi.fn();
  await renderMain({ onInterrupt, backgroundSubagentCount: 2 });
  await userEvent.keyboard("{Escape}{Escape}");
  const dialog = page.getByRole("alertdialog");
  await expect.element(dialog.getByText("Stop this thread?")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await settle();
  expect(onInterrupt).not.toHaveBeenCalled();
  await expect.element(visualHint()).not.toBeInTheDocument();
});
