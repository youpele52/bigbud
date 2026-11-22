import "../../../index.css";
import { Terminal } from "@xterm/xterm";
import type { NativeApi } from "@bigbud/contracts";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { TerminalLifecycleNotice } from "@bigbud/contracts/workspace/terminal.lifecycle.ts";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { subscribeAppTerminalState } from "../../../routes/-__root.terminal-events";
import { useTerminalStateStore } from "../../../stores/terminal/terminal.store";
import { TerminalViewport } from "../TerminalViewport";
import { TerminalViewParkingHost } from "./TerminalViewParkingHost";
import { terminalViewRegistry } from "./TerminalViewRegistry";

const mocks = vi.hoisted(() => ({
  ended: false,
  open: vi.fn(async (input: { threadId: string; terminalId: string }) => ({
    threadId: input.threadId,
    terminalId: input.terminalId,
    dropPathMode: "posix",
    cwd: "/repo",
    worktreePath: null,
    history: "",
    exitCode: null,
    exitSignal: null,
    updatedAt: mocks.ended ? "2026-11-22T10:10:00.000Z" : "2026-11-22T10:00:00.000Z",
    runtimeGeneration: "gen-1",
    screenSource: "host",
    ...(mocks.ended
      ? { status: "exited", pid: null, restorable: false, endedReason: "idle" }
      : { status: "running", pid: 1, restorable: true }),
  })),
  subscribeSession: vi.fn(
    (
      input: { threadId: string; terminalId: string },
      listener: (item: unknown) => void,
      options?: { onScreen?: (item: unknown) => void },
    ) => {
      queueMicrotask(() => {
        listener({ type: "subscribed", subscriptionId: `${input.threadId}-${input.terminalId}` });
        if (!mocks.ended)
          options?.onScreen?.({
            type: "screen",
            threadId: input.threadId,
            terminalId: input.terminalId,
            runtimeGeneration: "gen-1",
            throughSequence: "7",
            cols: 80,
            rows: 24,
            ansi: "IDLE SHELL\r\n$ ",
            pendingEscapeTail: "",
            scrollbackRows: 0,
            alternateScreen: false,
            fidelity: "full",
            cold: false,
          });
      });
      return () => undefined;
    },
  ),
  ackOutput: vi.fn(async () => undefined),
  resize: vi.fn(async () => undefined),
  write: vi.fn(async () => undefined),
  settings: {
    terminalFontFamily: "system-monospace",
    terminalFontSize: 12,
    terminalGpuAcceleration: "off",
  },
}));
vi.mock("../../../rpc/nativeApi", () => ({ readNativeApi: () => ({ terminal: mocks }) }));
vi.mock("../../../hooks/useSettings", () => ({ useSettings: () => mocks.settings }));
vi.mock("../../../lib/threadMaterialization", () => ({ ensureThreadMaterialized: vi.fn() }));

let opened = vi.spyOn(Terminal.prototype, "open");
const instances = () => opened.mock.instances as unknown as Terminal[];
const openedFor = (threadId: string) =>
  mocks.open.mock.calls.filter(([input]) => input.threadId === threadId);

const surface = (terminalIds: string[]) => ({
  terminalOpen: true,
  terminalHeight: 280,
  terminalIds,
  runningTerminalIds: [],
  activeTerminalId: terminalIds[0]!,
  terminalGroups: [{ id: `group-${terminalIds[0]}`, terminalIds }],
  activeTerminalGroupId: `group-${terminalIds[0]}`,
});

/** A drawer that renders exactly the panes its surface lists, as the real drawer does. */
function Drawer({ threadId }: { threadId: string }) {
  const terminalIds = useTerminalStateStore(
    (state) => state.terminalStateByThreadId[threadId as ThreadId]?.terminalIds,
  );
  return (
    <>
      {(terminalIds ?? []).map((terminalId) => (
        <div key={terminalId} style={{ width: 640, height: 320 }}>
          <TerminalViewport
            threadId={ThreadId.makeUnsafe(threadId)}
            terminalId={terminalId}
            terminalLabel="Terminal"
            visible
            cwd="/repo"
            onSessionExited={() => undefined}
            onAddTerminalContext={() => undefined}
            autoFocus={false}
            focusRequestId={0}
            resizeEpoch={0}
            drawerHeight={320}
            keybindings={[]}
          />
        </div>
      ))}
    </>
  );
}

let swap: (next: ReactNode) => void = () => undefined;
function Switcher({ initial }: { initial: ReactNode }) {
  const [content, setContent] = useState(initial);
  swap = setContent;
  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <TerminalViewParkingHost />
      {content}
    </div>
  );
}

/** Opens thread "a", then shows four other threads until its view is parked. */
async function parkThreadA() {
  await expect.poll(() => instances().length).toBeGreaterThan(0);
  const terminal = instances().at(-1)!;
  await expect.poll(() => terminal.options.disableStdin).toBe(false);
  swap(
    <>
      {["b", "c", "d", "e"].map((thread) => (
        <Drawer key={thread} threadId={thread} />
      ))}
    </>,
  );
  await expect.poll(() => terminalViewRegistry.viewState("a", "pane")).toBe("warm");
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
  terminalViewRegistry.runParkCheck();
  expect(terminalViewRegistry.viewState("a", "pane")).toBe("parked");
  vi.mocked(Date.now).mockRestore();
}

beforeEach(() => {
  vi.clearAllMocks();
  opened = vi.spyOn(Terminal.prototype, "open");
  mocks.ended = false;
  useTerminalStateStore.setState({
    terminalStateByThreadId: Object.fromEntries(
      ["a", "b", "c", "d", "e"].map((thread) => [thread, surface(["pane"])]),
    ),
    panelTerminalStateByThreadId: {},
  } as never);
});
afterEach(() => {
  terminalViewRegistry.disposeAll();
  vi.restoreAllMocks();
});

it("removes a parked pane on an idle close, so returning to the thread spawns nothing", async () => {
  let onLifecycle: ((notice: TerminalLifecycleNotice) => void) | undefined;
  const stop = subscribeAppTerminalState({
    terminal: {
      onEvent: (_listener, options) => {
        onLifecycle = options?.onLifecycle;
        return () => undefined;
      },
    } as Pick<NativeApi["terminal"], "onEvent"> as never,
    isArchived: () => false,
    applyEvents: () => undefined,
    reconcileInventory: () => undefined,
    applyWork: () => undefined,
    showLifecycleNotices: false,
    removeEndedTerminal: (threadId, terminalId) =>
      useTerminalStateStore.getState().removeEndedTerminal(threadId as ThreadId, terminalId),
  });
  const screen = await render(<Switcher initial={<Drawer threadId="a" />} />);
  await parkThreadA();
  // The host closes the hidden, idle terminal while its view is parked.
  onLifecycle!({
    type: "lifecycleNotice",
    noticeId: "host:pty-a:9",
    kind: "idleClosed",
    threadId: "a",
    terminalId: "pane",
    createdAt: "2026-11-22T10:10:00.000Z",
  });
  expect(useTerminalStateStore.getState().terminalStateByThreadId["a" as ThreadId]).toBeUndefined();
  await expect.poll(() => terminalViewRegistry.viewState("a", "pane")).toBeNull();
  swap(<Drawer threadId="a" />);
  await new Promise((resolve) => setTimeout(resolve, 100));
  // No pane, no view, and no second open (the open that would have respawned the shell).
  expect(terminalViewRegistry.viewState("a", "pane")).toBeNull();
  expect(openedFor("a")).toHaveLength(1);
  stop();
  await screen.unmount();
});

it("drops the pane when a remounted view learns from the server that the host closed it", async () => {
  const screen = await render(<Switcher initial={<Drawer threadId="a" />} />);
  await parkThreadA();
  // The close notice never reached this renderer; the server answers with the ended session.
  mocks.ended = true;
  swap(<Drawer threadId="a" />);
  await expect
    .poll(() => useTerminalStateStore.getState().terminalStateByThreadId["a" as ThreadId])
    .toBeUndefined();
  expect(openedFor("a")).toHaveLength(2);
  expect(openedFor("a")[1]![0]).not.toHaveProperty("attachOnly");
  await expect.poll(() => terminalViewRegistry.viewState("a", "pane")).toBeNull();
  await screen.unmount();
});
