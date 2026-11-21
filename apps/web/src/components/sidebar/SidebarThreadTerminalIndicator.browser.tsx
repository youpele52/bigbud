import "../../index.css";

import { beforeEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import {
  applyTerminalLivenessNotice,
  reconcileTerminalLivenessInventory,
  useTerminalLivenessStore,
} from "../../stores/terminal/terminalLiveness.store";
import { SidebarThreadTerminalIndicator } from "./SidebarThreadTerminalIndicator";

const at = new Date().toISOString();

beforeEach(() => {
  useTerminalLivenessStore.setState({ byThreadId: {} });
});

it("follows inventory and notices: muted, blue and pulsing when busy, amber when warned", async () => {
  const screen = await render(<SidebarThreadTerminalIndicator threadId="t1" finished={null} />);
  try {
    expect(screen.container.querySelector('[data-slot="thread-terminal-indicator"]')).toBeNull();
    reconcileTerminalLivenessInventory({
      type: "inventory",
      createdAt: at,
      sessions: [
        { threadId: "t1", terminalId: "a", activity: "quiet" },
        { threadId: "t2", terminalId: "x", activity: "busy" },
      ],
    });
    const muted = page.getByRole("img", { name: "1 terminal running" });
    await expect.element(muted).toHaveClass("text-muted-foreground");

    reconcileTerminalLivenessInventory({
      type: "inventory",
      createdAt: at,
      sessions: [
        { threadId: "t1", terminalId: "a", activity: "busy" },
        { threadId: "t1", terminalId: "b" },
        { threadId: "t1", terminalId: "c" },
      ],
    });
    const busy = page.getByRole("img", { name: "3 terminals running (1 busy)" });
    await expect.element(busy).toHaveClass("text-info-foreground");
    expect(busy.element().querySelector("svg")?.classList.contains("animate-pulse")).toBe(true);

    applyTerminalLivenessNotice({
      type: "lifecycleNotice",
      noticeId: "n-1",
      kind: "idleWarning",
      threadId: "t1",
      terminalId: "b",
      closesAt: new Date(Date.now() + 50_000).toISOString(),
      createdAt: at,
    });
    const warned = page.getByRole("img", { name: "Terminal closes in 1 minute (idle)" });
    await expect.element(warned).toHaveClass("text-warning");
  } finally {
    await screen.unmount();
  }
});

it("keeps finished terminal work ahead of live terminals", async () => {
  reconcileTerminalLivenessInventory({
    type: "inventory",
    createdAt: at,
    sessions: [{ threadId: "t1", terminalId: "a", activity: "busy" }],
  });
  const finished = {
    label: "Terminal command failed: make",
    colorClass: "text-destructive",
    pulse: false,
  };
  const screen = await render(<SidebarThreadTerminalIndicator threadId="t1" finished={finished} />);
  try {
    await expect
      .element(page.getByRole("img", { name: "Terminal command failed: make" }))
      .toHaveClass("text-destructive");
    expect(
      screen.container.querySelectorAll('[data-slot="thread-terminal-indicator"]'),
    ).toHaveLength(1);
  } finally {
    await screen.unmount();
  }
});
