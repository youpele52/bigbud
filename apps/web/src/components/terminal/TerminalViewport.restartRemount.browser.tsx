import "../../index.css";
import { afterEach, expect, it, vi } from "vitest";
import type { TerminalSessionSnapshot } from "@bigbud/contracts/workspace/terminal.ts";
import { render } from "vitest-browser-react";
import { TerminalSessionFixture } from "./TerminalViewport.session.fixture";
import { publishTerminalOutput } from "./TerminalOutputStream";
import {
  readTerminalLifecycle,
  useTerminalLifecycleStore,
} from "../../stores/terminal/terminalLifecycle.store";
import { forgetTerminalLaunch, recordTerminalLaunch } from "../../lib/terminalLaunchBinding";

const mocks = vi.hoisted(() => {
  const old = {
    threadId: "terminal-fixture",
    terminalId: "synthetic",
    cwd: "/synthetic",
    worktreePath: null,
    dropPathMode: "posix" as const,
    status: "running" as const,
    pid: 1,
    history: "old output",
    exitCode: null,
    exitSignal: null,
    updatedAt: "2026-10-29T10:00:00Z",
    runtimeGeneration: "old",
  };
  return {
    old,
    open: vi.fn(async () => old),
    snapshot: vi.fn(async (): Promise<TerminalSessionSnapshot> => old),
    restart: vi.fn(async (_request: unknown): Promise<TerminalSessionSnapshot> => old),
    confirm: vi.fn(async () => true),
    write: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
  };
});
vi.mock("../../rpc/nativeApi", () => ({
  readNativeApi: () => ({ terminal: mocks, dialogs: { confirm: mocks.confirm } }),
}));
afterEach(() => {
  useTerminalLifecycleStore.setState({ operations: {} });
  forgetTerminalLaunch("terminal-fixture", "synthetic");
  vi.clearAllMocks();
});

it("fetches a local history baseline when another view recorded newer metadata for the same generation", async () => {
  let completeOpen!: (value: typeof mocks.old) => void;
  mocks.open.mockImplementationOnce(
    () =>
      new Promise((done) => {
        completeOpen = done;
      }),
  );
  const fresh = {
    ...mocks.old,
    history: "fresh authoritative output",
    updatedAt: "2026-10-29T10:00:03Z",
  };
  mocks.snapshot.mockResolvedValueOnce(fresh);
  const screen = await render(
    <TerminalSessionFixture fontSize={12} onTerminal={() => undefined} />,
  );
  try {
    await expect.poll(() => mocks.open.mock.calls.length).toBe(1);
    recordTerminalLaunch(fresh);
    completeOpen(mocks.old);
    await expect.element(screen.getByText("ready", { exact: true })).toBeVisible();
    expect(mocks.snapshot).toHaveBeenCalledOnce();
    expect(mocks.open).toHaveBeenCalledOnce();
  } finally {
    await screen.unmount();
  }
});

it.each(["resolve", "reject"] as const)(
  "ignores an old startup snapshot that %ss after successful restart recovery",
  async (settlement) => {
    let completeRestart!: (value: TerminalSessionSnapshot) => void;
    let completeSnapshot!: (value: TerminalSessionSnapshot) => void;
    let failSnapshot!: (error: Error) => void;
    mocks.open.mockResolvedValue(mocks.old);
    mocks.restart.mockImplementationOnce(
      () =>
        new Promise((done) => {
          completeRestart = done;
        }),
    );
    let screen = await render(
      <TerminalSessionFixture fontSize={12} onTerminal={() => undefined} />,
    );
    try {
      await expect.element(screen.getByText("ready", { exact: true })).toBeVisible();
      await screen.getByRole("button", { name: "Restart fixture" }).click();
      await expect.poll(() => mocks.restart.mock.calls.length).toBe(1);
      await screen.unmount();
      mocks.snapshot.mockImplementationOnce(
        () =>
          new Promise((done, fail) => {
            completeSnapshot = done;
            failSnapshot = fail;
          }),
      );
      screen = await render(<TerminalSessionFixture fontSize={12} onTerminal={() => undefined} />);
      await expect.poll(() => mocks.snapshot.mock.calls.length).toBe(1);
      const fresh = {
        ...mocks.old,
        pid: 2,
        runtimeGeneration: "recovered",
        cwd: "/new",
        history: "replacement output",
        updatedAt: "2026-10-29T10:00:02Z",
      };
      completeRestart(fresh);
      await expect.element(screen.getByText("ready", { exact: true })).toBeVisible();
      if (settlement === "reject") failSnapshot(new Error("Old startup failed late"));
      else completeSnapshot(mocks.old);
      // Let the stale continuation run before checking readiness and subsequent command identity.
      await new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      );
      await expect.element(screen.getByText("ready", { exact: true })).toBeVisible();
      publishTerminalOutput({
        type: "output",
        threadId: fresh.threadId,
        terminalId: fresh.terminalId,
        createdAt: "2026-10-29T10:00:03Z",
        data: "still subscribed",
      });
      mocks.restart.mockResolvedValue({
        ...fresh,
        pid: 3,
        runtimeGeneration: "third",
        updatedAt: "2026-10-29T10:00:04Z",
      });
      await screen.getByRole("button", { name: "Restart fixture" }).click();
      await expect.poll(() => mocks.restart.mock.calls.length).toBe(2);
      expect(mocks.restart.mock.calls[1]![0]).toMatchObject({
        expectedGeneration: "recovered",
        cwd: "/new",
      });
      expect(mocks.open).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  },
);

it("does not roll back viewport launch metadata when an older restart response follows a newer event", async () => {
  let completeRestart!: (value: TerminalSessionSnapshot) => void;
  mocks.open.mockResolvedValue(mocks.old);
  mocks.restart.mockImplementationOnce(
    () =>
      new Promise((done) => {
        completeRestart = done;
      }),
  );
  const screen = await render(
    <TerminalSessionFixture fontSize={12} onTerminal={() => undefined} />,
  );
  try {
    await expect.element(screen.getByText("ready", { exact: true })).toBeVisible();
    await screen.getByRole("button", { name: "Restart fixture" }).click();
    await expect.poll(() => mocks.restart.mock.calls.length).toBe(1);
    const newest = {
      ...mocks.old,
      pid: 3,
      cwd: "/newest",
      runtimeGeneration: "C",
      history: "C output",
      updatedAt: "2026-10-29T10:00:03Z",
    };
    publishTerminalOutput({
      type: "restarted",
      threadId: newest.threadId,
      terminalId: newest.terminalId,
      createdAt: newest.updatedAt,
      snapshot: newest,
    });
    completeRestart({
      ...mocks.old,
      pid: 2,
      cwd: "/older",
      runtimeGeneration: "B",
      updatedAt: "2026-10-29T10:00:02Z",
    });
    await expect.element(screen.getByText("ready", { exact: true })).toBeVisible();
    mocks.restart.mockResolvedValue({
      ...newest,
      pid: 4,
      runtimeGeneration: "D",
      updatedAt: "2026-10-29T10:00:04Z",
    });
    await screen.getByRole("button", { name: "Restart fixture" }).click();
    await expect.poll(() => mocks.restart.mock.calls.length).toBe(2);
    expect(mocks.restart.mock.calls[1]![0]).toMatchObject({
      expectedGeneration: "C",
      cwd: "/newest",
    });
  } finally {
    await screen.unmount();
  }
});

it("adopts a failed replacement identity on remount without enabling input, allowing an explicit retry", async () => {
  let resolve!: (value: TerminalSessionSnapshot) => void;
  mocks.restart.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  let screen = await render(<TerminalSessionFixture fontSize={12} onTerminal={() => undefined} />);
  try {
    await expect.element(screen.getByText("ready", { exact: true })).toBeVisible();
    await screen.getByRole("button", { name: "Restart fixture" }).click();
    await expect.poll(() => mocks.restart.mock.calls.length).toBe(1);
    await screen.unmount();
    mocks.snapshot.mockRejectedValueOnce(new Error("Terminal is still starting"));
    screen = await render(<TerminalSessionFixture fontSize={12} onTerminal={() => undefined} />);
    await expect.poll(() => mocks.snapshot.mock.calls.length).toBe(1);
    const failed: TerminalSessionSnapshot = {
      ...mocks.old,
      status: "error",
      pid: null,
      runtimeGeneration: "failed",
      updatedAt: "2026-10-29T10:00:01Z",
    };
    resolve(failed);
    await expect
      .poll(() => readTerminalLifecycle(failed.threadId, failed.terminalId))
      .toBeUndefined();
    await expect.element(screen.getByText("paused", { exact: true })).toBeVisible();
    mocks.restart.mockResolvedValue({
      ...mocks.old,
      runtimeGeneration: "recovered",
      pid: 3,
      updatedAt: "2026-10-29T10:00:02Z",
    });
    await screen.getByRole("button", { name: "Restart fixture" }).click();
    await expect.poll(() => mocks.restart.mock.calls.length).toBe(2);
    expect(mocks.restart.mock.calls[1]![0]).toMatchObject({ expectedGeneration: "failed" });
    await expect.element(screen.getByText("ready", { exact: true })).toBeVisible();
    expect(mocks.open).toHaveBeenCalledOnce();
  } finally {
    await screen.unmount();
  }
});

it("recovers a remounted view when snapshot fails during slow replacement startup", async () => {
  let resolve!: (value: TerminalSessionSnapshot) => void;
  mocks.open.mockResolvedValue(mocks.old);
  mocks.restart.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  let screen = await render(<TerminalSessionFixture fontSize={12} onTerminal={() => undefined} />);
  try {
    await expect.element(screen.getByText("ready", { exact: true })).toBeVisible();
    await screen.getByRole("button", { name: "Restart fixture" }).click();
    await expect.poll(() => mocks.restart.mock.calls.length).toBe(1);
    await screen.unmount();
    mocks.snapshot.mockRejectedValueOnce(new Error("Terminal is still starting"));
    screen = await render(<TerminalSessionFixture fontSize={12} onTerminal={() => undefined} />);
    await expect.poll(() => mocks.snapshot.mock.calls.length).toBe(1);
    await expect.element(screen.getByText("paused", { exact: true })).toBeVisible();
    const fresh = {
      ...mocks.old,
      pid: 2,
      runtimeGeneration: "new",
      history: "new output",
      updatedAt: "2026-10-29T10:00:01Z",
    };
    // The paused view unsubscribed, so no restarted event is delivered to it.
    resolve(fresh);
    await expect
      .poll(() => readTerminalLifecycle(fresh.threadId, fresh.terminalId))
      .toBeUndefined();
    await expect.element(screen.getByText("ready", { exact: true })).toBeVisible();
    expect(mocks.open).toHaveBeenCalledOnce();
    expect(mocks.restart).toHaveBeenCalledOnce();
    mocks.restart.mockResolvedValue({ ...fresh, pid: 3, runtimeGeneration: "third" });
    await screen.getByRole("button", { name: "Restart fixture" }).click();
    await expect.poll(() => mocks.restart.mock.calls.length).toBe(2);
    expect(mocks.restart.mock.calls[1]![0]).toMatchObject({ expectedGeneration: "new" });
    await expect
      .poll(() => readTerminalLifecycle(fresh.threadId, fresh.terminalId))
      .toBeUndefined();
  } finally {
    await screen.unmount();
  }
});

it("adopts the replacement generation after remount during stop, then restarts again safely", async () => {
  let resolve!: (value: TerminalSessionSnapshot) => void;
  mocks.restart.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  let screen = await render(<TerminalSessionFixture fontSize={12} onTerminal={() => undefined} />);
  try {
    await expect.element(screen.getByText("ready", { exact: true })).toBeVisible();
    await screen.getByRole("button", { name: "Restart fixture" }).click();
    await expect.poll(() => mocks.restart.mock.calls.length).toBe(1);
    await screen.unmount();
    screen = await render(<TerminalSessionFixture fontSize={12} onTerminal={() => undefined} />);
    await expect.poll(() => mocks.snapshot.mock.calls.length).toBe(1);
    await expect.element(screen.getByText("paused", { exact: true })).toBeVisible();
    const fresh = {
      ...mocks.old,
      pid: 2,
      history: "fresh output",
      runtimeGeneration: "fresh",
      updatedAt: "2026-10-29T10:00:01Z",
    };
    publishTerminalOutput({
      type: "restarted",
      threadId: fresh.threadId,
      terminalId: fresh.terminalId,
      createdAt: fresh.updatedAt,
      snapshot: fresh,
    });
    resolve(fresh);
    await expect
      .poll(() => readTerminalLifecycle(fresh.threadId, fresh.terminalId))
      .toBeUndefined();
    await expect.element(screen.getByText("ready", { exact: true })).toBeVisible();
    mocks.restart.mockResolvedValue({ ...fresh, pid: 3, runtimeGeneration: "third" });
    await screen.getByRole("button", { name: "Restart fixture" }).click();
    await expect.poll(() => mocks.restart.mock.calls.length).toBe(2);
    expect(mocks.restart.mock.calls[1]![0]).toMatchObject({ expectedGeneration: "fresh" });
    await expect
      .poll(() => readTerminalLifecycle(fresh.threadId, fresh.terminalId))
      .toBeUndefined();
    expect(mocks.open).toHaveBeenCalledOnce();
  } finally {
    await screen.unmount();
  }
});
