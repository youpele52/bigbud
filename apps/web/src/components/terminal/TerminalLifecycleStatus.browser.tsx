import "../../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import {
  beginTerminalLifecycle,
  updateTerminalLifecycle,
  useTerminalLifecycleStore,
} from "../../stores/terminal/terminalLifecycle.store";
import { TerminalLifecycleLabel, TerminalLifecycleStatus } from "./TerminalLifecycleStatus";

afterEach(() => useTerminalLifecycleStore.setState({ operations: {} }));

it.each([
  { width: 640, height: 240 },
  { width: 900, height: 600 },
  { width: 320, height: 240 },
])(
  "centers the closing loader inside a $width × $height terminal window",
  async ({ width, height }) => {
    beginTerminalLifecycle("thread", "terminal", "close");
    const screen = await render(
      <div className="relative" style={{ width, height }} data-terminal-window>
        <span>retained terminal output</span>
        <TerminalLifecycleStatus
          threadId="thread"
          terminalId="terminal"
          retryClose={vi.fn()}
          retryRestart={vi.fn()}
        />
      </div>,
    );
    try {
      await expect.element(screen.getByText("Closing terminal…")).toBeVisible();
      const loader = screen.getByRole("status").element();
      const terminal = loader.closest("[data-terminal-window]")!;
      await expect
        .poll(() => {
          const bounds = loader.getBoundingClientRect();
          const parent = terminal.getBoundingClientRect();
          return Math.max(
            Math.abs(bounds.left + bounds.width / 2 - parent.left - parent.width / 2),
            Math.abs(bounds.top + bounds.height / 2 - parent.top - parent.height / 2),
          );
        })
        .toBeLessThan(1);
      expect(loader.querySelector("svg.animate-spin")).not.toBeNull();
      await expect.element(screen.getByText("retained terminal output")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  },
);

it("shows Closing without removing the output and keeps failed close recoverable after remount", async () => {
  const operation = beginTerminalLifecycle("thread", "terminal", "close")!;
  const retryClose = vi.fn();
  const retryRestart = vi.fn();
  const screen = await render(
    <div>
      <span>retained terminal output</span>
      <TerminalLifecycleLabel threadId="thread" terminalId="terminal" />
      <TerminalLifecycleStatus
        threadId="thread"
        terminalId="terminal"
        retryClose={retryClose}
        retryRestart={retryRestart}
      />
    </div>,
  );
  await expect.element(screen.getByText("Closing terminal…")).toBeVisible();
  await expect.element(screen.getByText("retained terminal output")).toBeVisible();
  updateTerminalLifecycle("thread", "terminal", operation, {
    phase: "error",
    error: "Shutdown could not be confirmed",
  });
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Shutdown could not be confirmed");
  await screen.getByRole("button", { name: "Retry close" }).click();
  expect(retryClose).toHaveBeenCalledOnce();
  expect(retryRestart).not.toHaveBeenCalled();
  await screen.unmount();
  const remount = await render(
    <TerminalLifecycleStatus
      threadId="thread"
      terminalId="terminal"
      retryClose={retryClose}
      retryRestart={retryRestart}
    />,
  );
  await expect.element(remount.getByRole("button", { name: "Retry close" })).toBeVisible();
});

it("shows Stopping and Starting for restart and routes retry to restart", async () => {
  const operation = beginTerminalLifecycle("thread", "terminal", "restart")!;
  const retryRestart = vi.fn();
  const screen = await render(
    <TerminalLifecycleStatus
      threadId="thread"
      terminalId="terminal"
      retryClose={vi.fn()}
      retryRestart={retryRestart}
    />,
  );
  await expect.element(screen.getByText("Stopping terminal…")).toBeVisible();
  updateTerminalLifecycle("thread", "terminal", operation, { phase: "starting" });
  await expect.element(screen.getByText("Starting terminal…")).toBeVisible();
  updateTerminalLifecycle("thread", "terminal", operation, {
    phase: "error",
    error: "Restart unconfirmed",
  });
  await screen.getByRole("button", { name: "Retry restart" }).click();
  expect(retryRestart).toHaveBeenCalledOnce();
});

it("offers honest view dismissal instead of retry for an unconfirmed direct close", async () => {
  const operation = beginTerminalLifecycle("thread", "default", "close")!;
  updateTerminalLifecycle("thread", "default", operation, {
    phase: "error",
    canDismiss: true,
    error: "Remote termination cannot be verified.",
  });
  const retryClose = vi.fn();
  const screen = await render(
    <TerminalLifecycleStatus
      threadId="thread"
      terminalId="default"
      retryClose={retryClose}
      retryRestart={vi.fn()}
    />,
  );
  await expect
    .element(
      screen.getByText("The remote process may still be running. Dismiss only hides this pane."),
    )
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Retry close" })).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Dismiss pane" }).click();
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  expect(retryClose).not.toHaveBeenCalled();
  await screen.unmount();
});
