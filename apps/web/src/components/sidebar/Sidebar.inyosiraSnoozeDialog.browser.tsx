import "~/index.css";
import { ThreadId } from "@bigbud/contracts";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { snoozeThread } from "./Sidebar.inyosira.actions";
import { buildInyosiraSnoozeMenuItem, runInyosiraMenuAction } from "./Sidebar.inyosira.menu";
import { useInyosiraSnoozePickerStore } from "./Sidebar.inyosira.snoozePicker";
import { SidebarInyosiraSnoozeDialog } from "./Sidebar.inyosiraSnoozeDialog";

vi.mock("./Sidebar.inyosira.actions", () => ({
  INYOSIRA_SNOOZE_PRESETS: [{ minutes: 10, label: "10 minutes" }],
  moveThreadsToState: vi.fn(),
  snoozeThread: vi.fn(),
}));

const threadId = ThreadId.makeUnsafe("snooze-dialog");

beforeEach(() => {
  vi.clearAllMocks();
  useInyosiraSnoozePickerStore.getState().open(threadId);
});

afterEach(() => useInyosiraSnoozePickerStore.getState().close());

it("defaults to 10 minutes and submits the clicked thread", async () => {
  const screen = await render(<SidebarInyosiraSnoozeDialog />);
  await expect.element(screen.getByRole("textbox")).toHaveValue("10");
  await expect.element(screen.getByText(/2 minutes to 24 hours/)).toBeVisible();
  await screen.getByRole("button", { name: "Snooze", exact: true }).click();
  expect(snoozeThread).toHaveBeenCalledWith(threadId, 10);
  expect(useInyosiraSnoozePickerStore.getState().threadId).toBeNull();
});

it("replaces the default when typing immediately after opening", async () => {
  const screen = await render(<SidebarInyosiraSnoozeDialog />);
  await expect.element(screen.getByRole("textbox")).toHaveFocus();
  await userEvent.keyboard("30");
  await expect.element(screen.getByRole("textbox")).toHaveValue("30");
  await userEvent.keyboard("{Enter}");
  expect(snoozeThread).toHaveBeenCalledWith(threadId, 30);
});

it("selects the default when opening an initially closed mounted dialog", async () => {
  useInyosiraSnoozePickerStore.getState().close();
  const screen = await render(<SidebarInyosiraSnoozeDialog />);
  await runInyosiraMenuAction(buildInyosiraSnoozeMenuItem(undefined).id, [threadId]);
  await expect.element(screen.getByRole("textbox")).toHaveFocus();
  await userEvent.keyboard("20{Enter}");
  expect(snoozeThread).toHaveBeenCalledWith(threadId, 20);
});

it("preserves the draft and selection when returning focus without closing", async () => {
  const screen = await render(<SidebarInyosiraSnoozeDialog />);
  const input = screen.getByRole("textbox");
  await expect.element(input).toHaveFocus();
  await userEvent.keyboard("30{ArrowLeft}");
  const element = input.element() as HTMLInputElement;
  expect(element.selectionStart).toBe(1);
  expect(element.selectionEnd).toBe(1);
  await userEvent.keyboard("{Tab}");
  await expect.element(screen.getByRole("button", { name: "Cancel", exact: true })).toHaveFocus();
  // Programmatic refocus preserves the caret and catches unconditional select-on-focus.
  element.focus();
  await expect.element(input).toHaveValue("30");
  expect(element.selectionStart).toBe(1);
  expect(element.selectionEnd).toBe(1);
  await userEvent.keyboard("5{Enter}");
  expect(snoozeThread).toHaveBeenCalledWith(threadId, 350);
});

it("selects the reset default when reopening the mounted dialog", async () => {
  const screen = await render(<SidebarInyosiraSnoozeDialog />);
  await screen.getByRole("textbox").fill("3h");
  await screen.getByRole("button", { name: "Cancel", exact: true }).click();
  await runInyosiraMenuAction(buildInyosiraSnoozeMenuItem(undefined).id, [threadId]);
  await expect.element(screen.getByRole("textbox")).toHaveValue("10");
  await expect.element(screen.getByRole("textbox")).toHaveFocus();
  await userEvent.keyboard("45");
  await expect.element(screen.getByRole("textbox")).toHaveValue("45");
  await userEvent.keyboard("{Enter}");
  expect(snoozeThread).toHaveBeenCalledWith(threadId, 45);
});

it.each([
  ["2", 2],
  ["1h 30m", 90],
  ["24h", 1440],
] as const)("accepts a custom duration of %s", async (input, minutes) => {
  const screen = await render(<SidebarInyosiraSnoozeDialog />);
  await screen.getByRole("textbox").fill(input);
  await screen.getByRole("button", { name: "Snooze", exact: true }).click();
  expect(snoozeThread).toHaveBeenCalledWith(threadId, minutes);
});

it.each(["1", "24h 1m", "soon", ""])("rejects invalid duration %s", async (input) => {
  const screen = await render(<SidebarInyosiraSnoozeDialog />);
  await screen.getByRole("textbox").fill(input);
  await expect.element(screen.getByRole("button", { name: "Snooze", exact: true })).toBeDisabled();
  expect(snoozeThread).not.toHaveBeenCalled();
});

it("cancels without snoozing and resets to 10 minutes when reopened from the menu", async () => {
  const screen = await render(<SidebarInyosiraSnoozeDialog />);
  await screen.getByRole("textbox").fill("3h");
  await screen.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(snoozeThread).not.toHaveBeenCalled();
  expect(useInyosiraSnoozePickerStore.getState().threadId).toBeNull();

  await runInyosiraMenuAction(buildInyosiraSnoozeMenuItem(undefined).id, [threadId]);
  await expect.element(screen.getByRole("textbox")).toHaveValue("10");
  await screen.getByRole("button", { name: "Snooze", exact: true }).click();
  expect(snoozeThread).toHaveBeenCalledWith(threadId, 10);
});
