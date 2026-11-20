import { dismissTerminalPaneInState } from "../../stores/terminal/terminal.store.dismiss";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadId, type NativeApi } from "@bigbud/contracts";
import {
  TerminalExecutionTargetError,
  type TerminalSessionSnapshot,
} from "@bigbud/contracts/workspace/terminal.ts";
import { useTerminalStateStore } from "../../stores/terminal/terminal.store";
import { terminalPersistenceOptions } from "../../stores/terminal/terminal.store.persistence";
import { createSingleThreadTerminalState } from "../../stores/terminal/helpers.store";
import {
  useTerminalLifecycleStore,
  readTerminalLifecycle,
} from "../../stores/terminal/terminalLifecycle.store";
import {
  recordTerminalLaunch,
  readTerminalLaunch,
  forgetTerminalLaunch,
} from "../../lib/terminalLaunchBinding";
import { closeTerminalConfirmed } from "./terminalLifecycle.operations";
import { dismissUnconfirmedTerminalPane } from "./terminalLifecycle.dismiss";

const threadId = ThreadId.makeUnsafe("dismiss-test");
const terminalId = "default";
const snapshot: TerminalSessionSnapshot = {
  threadId,
  terminalId,
  cwd: "/work",
  worktreePath: null,
  status: "running",
  pid: 23,
  history: "retained",
  exitCode: null,
  exitSignal: null,
  updatedAt: "2026-11-11T01:00:00Z",
  runtimeGeneration: "original",
  executionTargetId: "ssh:host=example.test&transport=direct-ssh",
  dropPathMode: "posix",
};
afterEach(() => {
  useTerminalStateStore.setState(useTerminalStateStore.getInitialState(), true);
  useTerminalLifecycleStore.setState({ operations: {} });
  forgetTerminalLaunch(threadId, terminalId);
});
it("dismisses only presentation, persists across reload, and never reuses the original identity", async () => {
  useTerminalStateStore.setState({
    terminalStateByThreadId: { [threadId]: createSingleThreadTerminalState(terminalId) },
    panelTerminalStateByThreadId: { [threadId]: createSingleThreadTerminalState(terminalId) },
  });
  recordTerminalLaunch(snapshot);
  const close = vi.fn().mockRejectedValue(
    new TerminalExecutionTargetError({
      threadId,
      terminalId,
      executionTargetId: snapshot.executionTargetId!,
      reason: "directShellUnconfirmed",
      detail: "Remote process may still be running.",
    }),
  );
  const confirmed = vi.fn();
  await closeTerminalConfirmed({
    api: { terminal: { close } } as unknown as NativeApi,
    threadId,
    terminalId,
    onConfirmed: confirmed,
  });
  expect(readTerminalLifecycle(threadId, terminalId)?.canDismiss).toBe(true);
  dismissUnconfirmedTerminalPane(threadId, terminalId);
  expect(close).toHaveBeenCalledTimes(1);
  expect(confirmed).not.toHaveBeenCalled();
  expect(readTerminalLaunch(threadId, terminalId)?.runtimeGeneration).toBe("original");
  const state = useTerminalStateStore.getState();
  expect(state.terminalStateByThreadId[threadId]?.terminalIds).not.toContain(terminalId);
  expect(state.terminalStateByThreadId[threadId]?.terminalOpen).toBe(false);
  expect(state.panelTerminalStateByThreadId[threadId]?.terminalIds).not.toContain(terminalId);
  const saved = terminalPersistenceOptions.partialize(state);
  const hydrated = terminalPersistenceOptions.merge(saved, useTerminalStateStore.getInitialState());
  useTerminalStateStore.setState(hydrated, true);
  useTerminalStateStore.getState().ensureTerminal(threadId, terminalId);
  useTerminalStateStore.getState().ensurePanelTerminal(threadId, terminalId);
  useTerminalStateStore
    .getState()
    .applyTerminalEvents([
      { type: "started", threadId, terminalId, snapshot, createdAt: snapshot.updatedAt },
    ]);
  expect(
    useTerminalStateStore.getState().terminalStateByThreadId[threadId]?.terminalIds,
  ).not.toContain(terminalId);
  expect(
    useTerminalStateStore.getState().panelTerminalStateByThreadId[threadId]?.terminalIds,
  ).not.toContain(terminalId);
});
it("generic close failures cannot dismiss an uncertain managed process", async () => {
  const confirmed = vi.fn();
  await closeTerminalConfirmed({
    api: {
      terminal: { close: vi.fn().mockRejectedValue(new Error("timeout")) },
    } as unknown as NativeApi,
    threadId,
    terminalId,
    onConfirmed: confirmed,
  });
  const state = useTerminalStateStore.getState();
  dismissUnconfirmedTerminalPane(threadId, terminalId);
  expect(useTerminalStateStore.getState()).toBe(state);
  expect(readTerminalLifecycle(threadId, terminalId)?.canDismiss).toBe(false);
});

it("does not dismiss a newer generation using an old close refusal", async () => {
  useTerminalStateStore.setState({
    terminalStateByThreadId: { [threadId]: createSingleThreadTerminalState(terminalId) },
  });
  recordTerminalLaunch(snapshot);
  await closeTerminalConfirmed({
    api: {
      terminal: {
        close: vi.fn().mockRejectedValue(
          new TerminalExecutionTargetError({
            threadId,
            terminalId,
            executionTargetId: snapshot.executionTargetId!,
            reason: "directShellUnconfirmed",
            detail: "Unconfirmed",
          }),
        ),
      },
    } as unknown as NativeApi,
    threadId,
    terminalId,
    onConfirmed: vi.fn(),
  });
  recordTerminalLaunch({
    ...snapshot,
    runtimeGeneration: "newer",
    updatedAt: "2026-11-11T02:00:00Z",
  });
  dismissUnconfirmedTerminalPane(threadId, terminalId);
  expect(useTerminalStateStore.getState().terminalStateByThreadId[threadId]?.terminalIds).toContain(
    terminalId,
  );
});

it("dismisses one split pane while preserving its neighbor and retained launch records", () => {
  const store = useTerminalStateStore.getState();
  store.ensureTerminal(threadId, terminalId);
  store.splitTerminal(threadId, "neighbor");
  const before = useTerminalStateStore.getState();
  const patch = dismissTerminalPaneInState(before, threadId, terminalId, "unused-replacement");
  expect(patch.terminalStateByThreadId?.[threadId]?.terminalIds).toEqual(["neighbor"]);
  expect(patch).not.toHaveProperty("terminalProfileLaunches");
  expect(patch).not.toHaveProperty("terminalAgentVersionByKey");
});
