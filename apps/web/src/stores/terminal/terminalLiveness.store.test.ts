import type { TerminalEvent } from "@bigbud/contracts";
import type { TerminalLifecycleNotice } from "@bigbud/contracts/workspace/terminal.lifecycle.ts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  applyTerminalLivenessEvents,
  applyTerminalLivenessNotice,
  reconcileTerminalLivenessInventory,
  selectThreadTerminalLiveness,
  useTerminalLivenessStore,
} from "./terminalLiveness.store";

const at = "2026-11-21T10:00:00.000Z";
const liveness = (threadId: string) =>
  selectThreadTerminalLiveness(useTerminalLivenessStore.getState(), threadId);
const notice = (
  kind: TerminalLifecycleNotice["kind"],
  extra: Partial<TerminalLifecycleNotice> = {},
): TerminalLifecycleNotice => ({
  type: "lifecycleNotice",
  noticeId: `${kind}-${Math.random()}`,
  kind,
  threadId: "t1",
  terminalId: "a",
  createdAt: at,
  ...extra,
});

beforeEach(() => useTerminalLivenessStore.setState({ byThreadId: {} }));

describe("terminal liveness", () => {
  it("replaces membership from each inventory and keeps unchanged threads stable", () => {
    reconcileTerminalLivenessInventory({
      type: "inventory",
      createdAt: at,
      sessions: [
        { threadId: "t1", terminalId: "a", activity: "busy" },
        { threadId: "t1", terminalId: "b", activity: "quiet", idleClosesAt: at },
        { threadId: "t2", terminalId: "c" },
      ],
    });
    expect(liveness("t1")).toEqual({
      a: { busy: true, idleClosesAt: null },
      b: { busy: false, idleClosesAt: at },
    });
    const t1 = liveness("t1");
    reconcileTerminalLivenessInventory({
      type: "inventory",
      createdAt: at,
      sessions: [
        { threadId: "t1", terminalId: "a", activity: "busy" },
        { threadId: "t1", terminalId: "b", activity: "quiet", idleClosesAt: at },
      ],
    });
    expect(liveness("t1")).toBe(t1);
    expect(liveness("t2")).toEqual({});
  });

  it("adds on start, follows activity, and removes on exit", () => {
    const base = { threadId: "t1", terminalId: "a", createdAt: at };
    applyTerminalLivenessEvents([
      { ...base, type: "started", snapshot: {} } as unknown as TerminalEvent,
    ]);
    expect(liveness("t1")).toEqual({ a: { busy: false, idleClosesAt: null } });
    applyTerminalLivenessEvents([{ ...base, type: "activity", hasRunningSubprocess: true }]);
    expect(liveness("t1").a?.busy).toBe(true);
    const before = useTerminalLivenessStore.getState();
    applyTerminalLivenessEvents([{ ...base, type: "output", data: "x" }]);
    expect(useTerminalLivenessStore.getState()).toBe(before);
    applyTerminalLivenessEvents([{ ...base, type: "exited", exitCode: 0, exitSignal: null }]);
    expect(useTerminalLivenessStore.getState().byThreadId).toEqual({});
  });

  it("sets and clears the idle deadline from notices and drops closed terminals", () => {
    const closesAt = "2026-11-21T10:01:00.000Z";
    applyTerminalLivenessNotice(notice("idleWarning", { closesAt }));
    expect(liveness("t1").a).toEqual({ busy: false, idleClosesAt: closesAt });
    applyTerminalLivenessNotice(notice("idleWarningCleared"));
    expect(liveness("t1").a?.idleClosesAt).toBeNull();
    for (const kind of ["idleClosed", "pressureClosed", "limitClosed"] as const) {
      applyTerminalLivenessNotice(notice("idleWarning", { closesAt }));
      applyTerminalLivenessNotice(notice(kind));
      expect(liveness("t1")).toEqual({});
    }
    // A cleared warning for an unknown terminal does not invent it.
    applyTerminalLivenessNotice(notice("idleWarningCleared", { terminalId: "ghost" }));
    expect(useTerminalLivenessStore.getState().byThreadId).toEqual({});
  });

  it("shows no indicator after an idle close followed by an inventory refresh", () => {
    reconcileTerminalLivenessInventory({
      type: "inventory",
      createdAt: at,
      sessions: [{ threadId: "t1", terminalId: "a", activity: "quiet" }],
    });
    applyTerminalLivenessNotice(notice("idleClosed"));
    expect(liveness("t1")).toEqual({});
    // The host re-sends inventory after the close: the retained session is listed, not live.
    reconcileTerminalLivenessInventory({
      type: "inventory",
      createdAt: at,
      sessions: [
        { threadId: "t1", terminalId: "a", live: false, activity: "quiet", restorable: false },
        { threadId: "t2", terminalId: "lost", live: false, activity: "quiet" },
      ],
    });
    expect(useTerminalLivenessStore.getState().byThreadId).toEqual({});
  });
});
