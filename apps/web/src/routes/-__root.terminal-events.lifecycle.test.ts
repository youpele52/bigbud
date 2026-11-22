import type { NativeApi, TerminalEvent } from "@bigbud/contracts";
import type { TerminalLifecycleNotice } from "@bigbud/contracts/workspace/terminal.lifecycle.ts";
import type { TerminalSessionInventory } from "@bigbud/contracts/workspace/terminal.stream.ts";
import { beforeEach, expect, it, vi } from "vitest";

import { toastManager } from "../components/ui/toast.manager";
import { useTerminalLivenessStore } from "../stores/terminal/terminalLiveness.store";
import { subscribeAppTerminalState } from "./-__root.terminal-events";

vi.mock("../components/ui/toast.manager", () => ({
  toastManager: { add: vi.fn(() => "toast"), close: vi.fn() },
}));

const at = "2026-11-21T10:00:00.000Z";

function fixture(showLifecycleNotices: boolean) {
  let emit!: (event: TerminalEvent) => void;
  let options!: Parameters<NativeApi["terminal"]["onEvent"]>[1];
  const unsubscribe = vi.fn();
  const terminal = {
    onEvent: (listener, nextOptions) => {
      emit = listener;
      options = nextOptions;
      return unsubscribe;
    },
    keepOpen: vi.fn(async () => undefined),
  } satisfies Pick<NativeApi["terminal"], "onEvent" | "keepOpen">;
  const applyEvents = vi.fn();
  const reconcileInventory = vi.fn();
  const removeEndedTerminal = vi.fn();
  const stop = subscribeAppTerminalState({
    terminal,
    isArchived: () => false,
    applyEvents,
    reconcileInventory,
    applyWork: vi.fn(),
    showLifecycleNotices,
    removeEndedTerminal,
  });
  return {
    emit,
    inventory: (item: TerminalSessionInventory) => options!.onInventory!(item),
    lifecycle: (item: TerminalLifecycleNotice) => options!.onLifecycle!(item),
    applyEvents,
    reconcileInventory,
    removeEndedTerminal,
    stop,
    unsubscribe,
  };
}

const warning: TerminalLifecycleNotice = {
  type: "lifecycleNotice",
  noticeId: "n-1",
  kind: "idleWarning",
  threadId: "t1",
  terminalId: "a",
  closesAt: "2026-11-21T10:10:00.000Z",
  createdAt: at,
};

beforeEach(() => {
  vi.clearAllMocks();
  useTerminalLivenessStore.setState({ byThreadId: {} });
});

it("feeds sidebar liveness from the same ordered pipeline and toasts lifecycle notices", async () => {
  const f = fixture(true);
  f.inventory({
    type: "inventory",
    createdAt: at,
    sessions: [{ threadId: "t1", terminalId: "a", activity: "busy" }],
  });
  expect(f.reconcileInventory).toHaveBeenCalledOnce();
  expect(useTerminalLivenessStore.getState().byThreadId.t1?.a?.busy).toBe(true);

  f.emit({
    threadId: "t1",
    terminalId: "a",
    createdAt: at,
    type: "activity",
    hasRunningSubprocess: false,
  });
  await Promise.resolve();
  expect(f.applyEvents).toHaveBeenCalledOnce();
  expect(useTerminalLivenessStore.getState().byThreadId.t1?.a?.busy).toBe(false);

  f.lifecycle(warning);
  expect(useTerminalLivenessStore.getState().byThreadId.t1?.a?.idleClosesAt).toBe(warning.closesAt);
  expect(toastManager.add).toHaveBeenCalledWith(expect.objectContaining({ type: "warning" }));

  f.stop();
  expect(f.unsubscribe).toHaveBeenCalledOnce();
  f.lifecycle({ ...warning, noticeId: "n-2", kind: "idleClosed" });
  expect(toastManager.add).toHaveBeenCalledOnce();
});

it("updates liveness without toasting in a renderer that does not own notifications", () => {
  const f = fixture(false);
  f.lifecycle(warning);
  expect(useTerminalLivenessStore.getState().byThreadId.t1?.a?.idleClosesAt).toBe(warning.closesAt);
  expect(toastManager.add).not.toHaveBeenCalled();
  f.stop();
});

it("removes the pane on a host close, with or without toasts, but keeps a host-lost pane", () => {
  for (const show of [true, false]) {
    const f = fixture(show);
    f.lifecycle({ ...warning, noticeId: `closed-${show}`, kind: "idleClosed" });
    expect(f.removeEndedTerminal).toHaveBeenCalledWith("t1", "a");
    f.lifecycle({ ...warning, noticeId: `lost-${show}`, kind: "hostLost", terminalId: "b" });
    f.lifecycle({ ...warning, noticeId: `warn-${show}` });
    expect(f.removeEndedTerminal).toHaveBeenCalledOnce();
    f.stop();
  }
});
