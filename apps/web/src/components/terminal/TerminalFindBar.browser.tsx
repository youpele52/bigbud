import "../../index.css";
import "@xterm/xterm/css/xterm.css";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import { TerminalFindBar } from "./TerminalFindBar";
import type { TerminalFindSeed, TerminalFindState } from "./TerminalViewport.viewState";

async function setup(seed: TerminalFindSeed | null) {
  const mount = document.createElement("div");
  mount.style.cssText = "position: relative; width: 700px; height: 240px";
  document.body.append(mount);
  const terminal = new Terminal({ rows: 10, cols: 80, allowProposedApi: true });
  const search = new SearchAddon();
  terminal.loadAddon(search);
  terminal.open(mount);
  const lines = Array.from({ length: 60 }, (_, line) => `line ${line}`);
  lines[10] = "error: first failure";
  lines[30] = "error: the clicked hit";
  lines[50] = "error: newest failure";
  await new Promise<void>((resolve) => terminal.write(lines.join("\r\n"), resolve));
  const close = vi.fn();
  const find: TerminalFindState = {
    open: true,
    requestId: 1,
    seed,
    search: () => search,
    terminal: () => terminal,
    close,
  };
  const host = document.createElement("div");
  mount.append(host);
  const screen = await render(<TerminalFindBar find={find} />, { container: host });
  const selectedRow = () => terminal.getSelectionPosition()?.start.y;
  return {
    screen,
    close,
    selectedRow,
    dispose: async () => {
      await screen.unmount();
      terminal.dispose();
      mount.remove();
    },
  };
}

it("uses the app input, focused on open, and navigates and closes from the keyboard", async () => {
  const { screen, close, selectedRow, dispose } = await setup(null);
  try {
    const input = screen.getByRole("textbox", { name: "Find in terminal" });
    await expect.element(input).toHaveFocus();
    // The app's standard Input frame (same styling as settings fields).
    expect(input.element().closest("[data-slot=input-control]")).not.toBeNull();
    await userEvent.type(input, "error");
    await expect.poll(selectedRow).toBe(10);
    await userEvent.keyboard("{Enter}");
    await expect.poll(selectedRow).toBe(30);
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    await expect.poll(selectedRow).toBe(10);
    await userEvent.keyboard("{Escape}");
    expect(close).toHaveBeenCalledOnce();
  } finally {
    await dispose();
  }
});

it("opens a global search hit on its own line, not the newest match", async () => {
  const { screen, selectedRow, dispose } = await setup({
    query: "error",
    lineText: "error: the clicked hit",
  });
  try {
    await expect
      .element(screen.getByRole("textbox", { name: "Find in terminal" }))
      .toHaveValue("error");
    await expect.poll(selectedRow).toBe(30);
  } finally {
    await dispose();
  }
});
