import "../../index.css";

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { TerminalLimitDialog } from "./TerminalLimitDialog";
import { TERMINAL_LIMIT_EVICT_LABEL } from "./TerminalLimitDialog.logic";
import { promptTerminalLimit } from "./terminalLimitPrompt";

vi.mock("./terminalLifecycle.labels", () => ({
  resolveTerminalNoticeNames: () => ({ label: "Terminal 3", thread: "Old thread" }),
}));

const candidate = {
  threadId: "t-old",
  terminalId: "old",
  lastUsedAt: "2026-11-21T09:00:00.000Z",
  busy: true,
};

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse("2026-11-21T10:00:00.000Z"), toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

it("asks before closing the oldest terminal and evicts only on the destructive button", async () => {
  const screen = await render(<TerminalLimitDialog />);
  try {
    const decision = promptTerminalLimit({ limit: 24, liveCount: 24, candidate });
    const dialog = page.getByRole("alertdialog", { name: "Terminal limit reached" });
    await expect.element(dialog).toBeVisible();
    await expect
      .element(dialog)
      .toHaveTextContent(
        "You have 24 terminals running, the most bigbud allows. Opening another one requires closing one first.",
      );
    await expect
      .element(page.getByText("Oldest: “Terminal 3” in “Old thread”, last used 1h ago, busy."))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await page.getByRole("button", { name: TERMINAL_LIMIT_EVICT_LABEL }).click();
    await expect(decision).resolves.toBe("evict");
    await expect.element(dialog).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});

it("cancels on Escape and offers only Cancel when nothing can be closed", async () => {
  const screen = await render(<TerminalLimitDialog />);
  try {
    const escaped = promptTerminalLimit({ limit: 24, liveCount: 24, candidate });
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect(escaped).resolves.toBe("cancel");

    const blocked = promptTerminalLimit({ limit: 24, liveCount: 24, candidate: null });
    await expect
      .element(page.getByText("none can be closed for you", { exact: false }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: TERMINAL_LIMIT_EVICT_LABEL }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(blocked).resolves.toBe("cancel");
  } finally {
    await screen.unmount();
  }
});

it("cancels a waiting prompt when the dialog host unmounts", async () => {
  const screen = await render(<TerminalLimitDialog />);
  const decision = promptTerminalLimit({ limit: 24, liveCount: 24, candidate });
  await expect.element(page.getByRole("alertdialog")).toBeVisible();
  await screen.unmount();
  await expect(decision).resolves.toBe("cancel");
});
