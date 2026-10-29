import "../../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import {
  beginTerminalLifecycle,
  useTerminalLifecycleStore,
} from "../../stores/terminal/terminalLifecycle.store";
import { TerminalFontController } from "./TerminalFontController";
import { TerminalSessionFixture } from "./TerminalViewport.session.fixture";

const mocks = vi.hoisted(() => {
  const snapshot = {
    threadId: "terminal-fixture",
    terminalId: "synthetic",
    cwd: "/synthetic",
    worktreePath: null,
    dropPathMode: "posix",
    status: "running",
    pid: 1,
    history: "retained output",
    exitCode: null,
    exitSignal: null,
    updatedAt: "2026-10-29T10:00:00Z",
    runtimeGeneration: "original",
  };
  return {
    open: vi.fn(async () => snapshot),
    snapshot: vi.fn(async () => snapshot),
    write: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
  };
});
vi.mock("../../rpc/nativeApi", () => ({ readNativeApi: () => ({ terminal: mocks }) }));
afterEach(() => {
  useTerminalLifecycleStore.setState({ operations: {} });
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("reattaches read-only without opening or replacing a shell while close owns its lifecycle", async () => {
  beginTerminalLifecycle("terminal-fixture", "synthetic", "close");
  const screen = await render(
    <TerminalSessionFixture fontSize={12} onTerminal={() => undefined} />,
  );
  await expect.poll(() => mocks.snapshot.mock.calls.length).toBe(1);
  expect(mocks.open).not.toHaveBeenCalled();
  await expect.element(screen.getByText("paused")).toBeVisible();
  await screen.unmount();
});

it("does not open when Close begins during font readiness", async () => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wait = vi.spyOn(TerminalFontController.prototype, "whenReady").mockReturnValue(ready);
  const screen = await render(
    <TerminalSessionFixture fontSize={12} onTerminal={() => undefined} />,
  );
  try {
    await expect.poll(() => wait.mock.calls.length).toBeGreaterThan(0);
    beginTerminalLifecycle("terminal-fixture", "synthetic", "close");
    release();
    await expect.poll(() => mocks.snapshot.mock.calls.length).toBe(1);
    expect(mocks.open).not.toHaveBeenCalled();
    await expect.element(screen.getByText("paused")).toBeVisible();
  } finally {
    await screen.unmount();
  }
});
