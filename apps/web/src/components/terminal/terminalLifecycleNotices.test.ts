import type { TerminalLifecycleNotice } from "@bigbud/contracts/workspace/terminal.lifecycle.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTerminalLifecycleNotices } from "./terminalLifecycleNotices";

const NOW = Date.parse("2026-11-21T10:09:00.000Z");
const candidate = {
  threadId: "t-old",
  terminalId: "old",
  lastUsedAt: "2026-11-21T09:00:00.000Z",
  busy: true,
};
let sequence = 0;
const notice = (
  kind: TerminalLifecycleNotice["kind"],
  extra: Partial<TerminalLifecycleNotice> = {},
): TerminalLifecycleNotice => ({
  type: "lifecycleNotice",
  noticeId: `n-${++sequence}`,
  kind,
  threadId: "t1",
  terminalId: "a",
  createdAt: "2026-11-21T10:09:00.000Z",
  ...extra,
});

type AddOptions = { type?: string; title?: string; timeout?: number; actionProps?: unknown };

function fixture(
  overrides: { keepOpen?: unknown; retrySetup?: unknown; closeDrainingHosts?: unknown } = {},
) {
  let nextId = 0;
  const add = vi.fn((_options: AddOptions) => `toast-${++nextId}`);
  const close = vi.fn();
  const terminal = {
    keepOpen: vi.fn(async () => undefined),
    retrySetup: vi.fn(async () => ({
      status: "started" as const,
      scriptId: "setup",
      scriptName: "Install",
      terminalId: "setup-1",
      cwd: "/repo",
    })),
    closeDrainingHosts: vi.fn(async () => ({ closed: 1, remaining: 0 })),
    ...overrides,
  };
  const notices = createTerminalLifecycleNotices({
    terminal: terminal as never,
    toasts: { add, close } as never,
    names: (threadId, terminalId) => ({
      label: terminalId === "old" ? "Terminal 3" : "Terminal 1",
      thread: threadId === "t-old" ? "Old thread" : "Fix login",
    }),
    now: () => NOW,
  });
  const lastOptions = () => add.mock.calls.at(-1)![0];
  const clickAction = () =>
    (lastOptions().actionProps as { onClick: () => void } | undefined)!.onClick();
  return { add, close, terminal, notices, lastOptions, clickAction };
}

beforeEach(() => {
  sequence = 0;
});

describe("terminal lifecycle notices", () => {
  it("warns in amber with Keep open until the close time, and dismisses on clear", async () => {
    const f = fixture();
    f.notices.handle(notice("idleWarning", { closesAt: "2026-11-21T10:10:00.000Z" }));
    expect(f.lastOptions()).toMatchObject({
      type: "warning",
      title: "“Terminal 1” in “Fix login” has been idle for 9 minutes and will close in 1 minute.",
      timeout: 60_000,
      actionProps: { children: "Keep open" },
    });
    f.clickAction();
    await Promise.resolve();
    expect(f.terminal.keepOpen).toHaveBeenCalledExactlyOnceWith({
      threadId: "t1",
      terminalId: "a",
    });
    expect(f.close).toHaveBeenCalledWith("toast-1");

    f.notices.handle(notice("idleWarning", { closesAt: "2026-11-21T10:10:00.000Z" }));
    f.notices.handle(notice("idleWarningCleared"));
    expect(f.close).toHaveBeenLastCalledWith("toast-2");
    expect(f.add).toHaveBeenCalledTimes(2);
  });

  it("replaces the warning with the close toast and shows each notice id once", () => {
    const f = fixture();
    const warning = notice("idleWarning", { closesAt: "2026-11-21T10:10:00.000Z" });
    f.notices.handle(warning);
    f.notices.handle(warning);
    expect(f.add).toHaveBeenCalledTimes(1);
    f.notices.handle(notice("idleClosed"));
    expect(f.close).toHaveBeenCalledWith("toast-1");
    expect(f.lastOptions()).toMatchObject({
      type: "warning",
      title: "Closed idle terminal “Terminal 1” in “Fix login”.",
    });
  });

  it("maps pressure, limit, offline and host notices to their colours and copy", () => {
    const f = fixture();
    const shown = (kind: TerminalLifecycleNotice["kind"], extra = {}) => {
      f.notices.handle(notice(kind, extra));
      return f.lastOptions();
    };
    expect(shown("pressureClosed")).toMatchObject({
      type: "warning",
      title: "Memory is low, so bigbud closed the idle terminal “Terminal 1” in “Fix login”.",
    });
    expect(shown("pressureNoCandidate").title).toBe(
      "Memory is low. No hidden idle terminals could be closed.",
    );
    expect(shown("limitClosed").title).toBe(
      "Closed “Terminal 1” in “Fix login” to open a new terminal.",
    );
    expect(shown("offlineClosed", { count: 3 }).title).toBe(
      "While bigbud was closed, 3 terminals were closed because they were idle.",
    );
    expect(shown("hostLost").type).toBe("error");
    expect(shown("backendRestartStopped").title).toBe(
      "Terminals were stopped because the backend restarted.",
    );
    const before = f.add.mock.calls.length;
    for (const kind of ["quitClosed", "orphanClosed", "modelInvalid", "spoolDegraded"] as const)
      f.notices.handle(notice(kind));
    expect(f.add).toHaveBeenCalledTimes(before);
  });

  it("offers Close oldest and run setup, retrying with the candidate as evict", async () => {
    const f = fixture();
    f.notices.handle(
      notice("setupBlockedByLimit", { terminalId: undefined, candidate, limit: 24 }),
    );
    expect(f.lastOptions()).toMatchObject({
      type: "warning",
      title: "Terminal limit reached, so the setup script didn't start.",
      actionProps: { children: "Close oldest and run setup" },
    });
    f.clickAction();
    await vi.waitFor(() => expect(f.add).toHaveBeenCalledTimes(2));
    expect(f.close).toHaveBeenCalledWith("toast-1");
    expect(f.terminal.retrySetup).toHaveBeenCalledExactlyOnceWith({
      threadId: "t1",
      evict: { threadId: "t-old", terminalId: "old" },
    });
    expect(f.lastOptions()).toMatchObject({
      type: "success",
      title: "Setup script “Install” started.",
    });
  });

  it("reports a failed setup retry in red and shows no action without a candidate", async () => {
    const f = fixture({ retrySetup: vi.fn(async () => Promise.reject(new Error("inputs gone"))) });
    f.notices.handle(notice("setupBlockedByLimit", { terminalId: undefined, candidate }));
    f.clickAction();
    await vi.waitFor(() => expect(f.add).toHaveBeenCalledTimes(2));
    expect(f.lastOptions()).toMatchObject({
      type: "error",
      title: "The setup script didn't start",
      description: "inputs gone",
    });
    f.notices.handle(notice("setupBlockedByLimit", { terminalId: undefined, limit: 24 }));
    expect(f.lastOptions().actionProps).toBeUndefined();
    expect(f.lastOptions()).toMatchObject({
      description:
        "Setup script didn't run because the terminal limit (24) is reached. Close a terminal and run it again.",
    });
  });

  it("offers Close them for old hosts and reports when every host stopped", async () => {
    const f = fixture();
    f.notices.handle(
      notice("legacyHostUnreachable", { threadId: undefined, terminalId: undefined }),
    );
    expect(f.lastOptions()).toMatchObject({
      type: "warning",
      title: "Terminals from a previous bigbud version are still running but can't be reconnected.",
      timeout: 0,
      actionProps: { children: "Close them" },
    });
    f.clickAction();
    await vi.waitFor(() => expect(f.add).toHaveBeenCalledTimes(2));
    expect(f.close).toHaveBeenCalledWith("toast-1");
    expect(f.terminal.closeDrainingHosts).toHaveBeenCalledOnce();
    expect(f.lastOptions()).toMatchObject({ type: "success" });
  });

  it("warns when an old host could not be closed safely, and errors in red on failure", async () => {
    const partial = fixture({
      closeDrainingHosts: vi.fn(async () => ({ closed: 0, remaining: 1 })),
    });
    partial.notices.handle(notice("legacyHostUnreachable"));
    partial.clickAction();
    await vi.waitFor(() => expect(partial.add).toHaveBeenCalledTimes(2));
    expect(partial.lastOptions()).toMatchObject({ type: "warning" });

    const failed = fixture({
      closeDrainingHosts: vi.fn(async () => Promise.reject(new Error("offline"))),
    });
    failed.notices.handle(notice("legacyHostUnreachable"));
    failed.clickAction();
    await vi.waitFor(() => expect(failed.add).toHaveBeenCalledTimes(2));
    expect(failed.lastOptions()).toMatchObject({ type: "error", description: "offline" });
  });

  it("stops after dispose", () => {
    const f = fixture();
    f.notices.dispose();
    f.notices.handle(notice("pressureNoCandidate"));
    expect(f.add).not.toHaveBeenCalled();
  });
});
