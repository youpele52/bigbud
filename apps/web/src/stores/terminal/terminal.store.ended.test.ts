import type { TerminalLifecycleNotice } from "@bigbud/contracts/workspace/terminal.lifecycle.ts";
import { beforeEach, describe, expect, it } from "vitest";

import { selectTerminalPaneOrigin } from "./helpers.store";
import { useTerminalStateStore } from "./terminal.store";
import { terminalNoticeEndsPane, terminalSnapshotHostClosed } from "./terminal.store.ended";
import { THREAD_ID, resetTerminalStore } from "./terminal.store.test.helpers";

const notice = (kind: TerminalLifecycleNotice["kind"]): TerminalLifecycleNotice => ({
  type: "lifecycleNotice",
  noticeId: `${kind}-1`,
  kind,
  threadId: THREAD_ID,
  terminalId: "a",
  createdAt: "2026-11-22T10:00:00.000Z",
});

const surface = (terminalIds: string[], extra: Record<string, unknown> = {}) => ({
  terminalOpen: true,
  terminalHeight: 280,
  terminalIds,
  runningTerminalIds: [],
  activeTerminalId: terminalIds[0]!,
  terminalGroups: [{ id: `group-${terminalIds[0]}`, terminalIds }],
  activeTerminalGroupId: `group-${terminalIds[0]}`,
  ...extra,
});

beforeEach(() => resetTerminalStore());

describe("panes whose terminal the host closed", () => {
  it("ends the pane for every host close except a host loss", () => {
    for (const kind of [
      "idleClosed",
      "pressureClosed",
      "limitClosed",
      "orphanClosed",
      "quitClosed",
    ] as const)
      expect(terminalNoticeEndsPane(notice(kind))).toBe(true);
    // A host-lost terminal stays read-only with its last screen (§11.1).
    expect(terminalNoticeEndsPane(notice("hostLost"))).toBe(false);
    expect(terminalNoticeEndsPane(notice("idleWarning"))).toBe(false);
    expect(terminalNoticeEndsPane({ ...notice("idleClosed"), terminalId: undefined })).toBe(false);
  });

  it("removes a pane with no mounted view, and empties the surface with the last one", () => {
    useTerminalStateStore.setState({
      terminalStateByThreadId: { [THREAD_ID]: surface(["a", "b"]) },
      panelTerminalStateByThreadId: { [THREAD_ID]: surface(["p"]) },
    });
    const store = () => useTerminalStateStore.getState();
    store().removeEndedTerminal(THREAD_ID, "a");
    expect(store().terminalStateByThreadId[THREAD_ID]?.terminalIds).toEqual(["b"]);
    store().removeEndedTerminal(THREAD_ID, "b");
    // Closing the last pane leaves the thread with no terminal and a closed drawer.
    expect(store().terminalStateByThreadId[THREAD_ID]).toBeUndefined();
    store().removeEndedTerminal(THREAD_ID, "p");
    expect(store().panelTerminalStateByThreadId[THREAD_ID]).toBeUndefined();
    // An unknown pane changes nothing.
    const before = store();
    store().removeEndedTerminal(THREAD_ID, "ghost");
    expect(store().terminalStateByThreadId).toBe(before.terminalStateByThreadId);
  });

  it("recognises an open answered with a host-closed session", () => {
    const snapshot = {
      threadId: THREAD_ID,
      terminalId: "a",
      dropPathMode: "posix" as const,
      cwd: "/repo",
      worktreePath: null,
      status: "exited" as const,
      pid: null,
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: "2026-11-22T10:00:00.000Z",
    };
    for (const endedReason of ["idle", "memory", "limit", "orphan"] as const)
      expect(terminalSnapshotHostClosed({ ...snapshot, endedReason })).toBe(true);
    for (const endedReason of ["exited", "host-lost", "user", "quit"] as const)
      expect(terminalSnapshotHostClosed({ ...snapshot, endedReason })).toBe(false);
    expect(terminalSnapshotHostClosed(snapshot)).toBe(false);
    expect(
      terminalSnapshotHostClosed({ ...snapshot, status: "running", pid: 1, endedReason: "idle" }),
    ).toBe(false);
  });

  it("keeps a restored pane's origin for the panes that remain", () => {
    useTerminalStateStore.setState({
      terminalStateByThreadId: {
        [THREAD_ID]: surface(["a", "r"], { restoredTerminalIds: ["a", "r"] }),
      },
    });
    useTerminalStateStore.getState().removeEndedTerminal(THREAD_ID, "a");
    expect(selectTerminalPaneOrigin(useTerminalStateStore.getState(), THREAD_ID, "r")).toBe(
      "restored",
    );
  });
});
