import "../../../index.css";
import { Terminal } from "@xterm/xterm";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useTerminalStateStore } from "../../../stores/terminal/terminal.store";
import { TerminalViewport } from "../TerminalViewport";
import { ThreadTerminalDrawerViewport } from "../ThreadTerminalDrawerViewport";
import { TerminalViewParkingHost } from "./TerminalViewParkingHost";
import { terminalViewRegistry } from "./TerminalViewRegistry";

const mocks = vi.hoisted(() => ({
  restorable: false,
  screenText: "",
  open: vi.fn(async (input: { threadId: string; terminalId: string }) => ({
    threadId: input.threadId,
    terminalId: input.terminalId,
    dropPathMode: "posix",
    cwd: "/repo",
    worktreePath: null,
    status: "running",
    pid: 1,
    history: mocks.restorable ? "" : `prompt ${input.threadId}/${input.terminalId}\r\n`,
    exitCode: null,
    exitSignal: null,
    updatedAt: "2026-11-21T10:00:00.000Z",
    runtimeGeneration: "gen-1",
    ...(mocks.restorable ? { screenSource: "host", restorable: true } : {}),
  })),
  subscribeSession: vi.fn(
    (
      input: { threadId: string; terminalId: string },
      listener: (item: unknown) => void,
      options?: { onScreen?: (item: unknown) => void },
    ) => {
      queueMicrotask(() => {
        listener({ type: "subscribed", subscriptionId: `${input.threadId}-${input.terminalId}` });
        if (mocks.restorable)
          options?.onScreen?.({
            type: "screen",
            threadId: input.threadId,
            terminalId: input.terminalId,
            runtimeGeneration: "gen-1",
            throughSequence: "7",
            cols: 80,
            rows: 24,
            ansi: mocks.screenText,
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
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useParams: () => "a",
}));

let opened = vi.spyOn(Terminal.prototype, "open");
const instances = () => opened.mock.instances as unknown as Terminal[];
const text = (terminal: Terminal) => {
  const buffer = terminal.buffer.active;
  return Array.from({ length: buffer.length }, (_, row) =>
    buffer.getLine(row)?.translateToString(true),
  )
    .join("\n")
    .trim();
};

function seedPanes(panes: Record<string, string[]>, panel: Record<string, string[]> = {}) {
  useTerminalStateStore.setState({
    terminalStateByThreadId: surface(panes),
    panelTerminalStateByThreadId: surface(panel),
  } as never);
}

function surface(ids: Record<string, string[]>) {
  return Object.fromEntries(
    Object.entries(ids).map(([thread, terminalIds]) => [thread, { terminalIds }]),
  );
}

function Pane({ threadId, terminalId = "pane" }: { threadId: string; terminalId?: string }) {
  return (
    <div style={{ width: 640, height: 320 }}>
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

async function settledView() {
  await expect.poll(() => instances().length).toBeGreaterThan(0);
  const terminal = instances().at(-1)!;
  await expect.poll(() => terminal.options.disableStdin).toBe(false);
  return terminal;
}

beforeEach(() => {
  vi.clearAllMocks();
  opened = vi.spyOn(Terminal.prototype, "open");
  mocks.restorable = false;
  seedPanes({ a: ["pane"], b: ["pane"], c: ["pane"], d: ["pane"], e: ["pane"] });
});
afterEach(() => {
  terminalViewRegistry.disposeAll();
  vi.restoreAllMocks();
});

it("survives the _chat.$threadId.tsx placeholder and a ThreadRemoteTargetGate-style replacement", async () => {
  const screen = await render(<Switcher initial={<Pane threadId="a" />} />);
  const terminal = await settledView();
  const element = terminal.element;
  expect(text(terminal)).toContain("prompt a/pane");
  // The route renders a logo placeholder instead of ChatView (bootstrap or thread fetch).
  swap(<div data-testid="placeholder">logo</div>);
  await expect.poll(() => element?.closest("[data-terminal-view-holder]")).not.toBeNull();
  swap(<Pane threadId="a" />);
  await expect.poll(() => element?.closest("[data-terminal-view-slot]")).not.toBeNull();
  expect(instances()).toHaveLength(1);
  expect(terminal.element).toBe(element);
  expect(text(terminal)).toContain("prompt a/pane");
  expect(mocks.open).toHaveBeenCalledOnce();
  await screen.unmount();
});

it("survives a route change to settings and back", async () => {
  const rootRoute = createRootRoute({
    component: () => (
      <div style={{ position: "fixed", inset: 0 }}>
        <TerminalViewParkingHost />
        <Outlet />
      </div>
    ),
  });
  const chat = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <Pane threadId="a" />,
  });
  const settings = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    component: () => <p>Settings</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([chat, settings]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const screen = await render(<RouterProvider router={router} />);
  const terminal = await settledView();
  const element = terminal.element;
  await router.navigate({ to: "/settings" });
  await expect.element(screen.getByText("Settings")).toBeVisible();
  expect(element?.closest("[data-terminal-view-holder]")).not.toBeNull();
  await router.navigate({ to: "/" });
  await expect.poll(() => element?.closest("[data-terminal-view-slot]")).not.toBeNull();
  expect(instances()).toHaveLength(1);
  expect(text(terminal)).toContain("prompt a/pane");
  expect(mocks.open).toHaveBeenCalledOnce();
  await screen.unmount();
});

it("keeps right-panel views across thread switches without spawning", async () => {
  seedPanes({}, { a: ["panel-a"], b: ["panel-b"] });
  const panel = (threadId: string) => (
    <div key={threadId} style={{ width: 640, height: 320 }}>
      <ThreadTerminalDrawerViewport
        threadId={ThreadId.makeUnsafe(threadId)}
        executionTargetId={undefined}
        cwd="/repo"
        worktreePath={null}
        runtimeEnv={undefined}
        visible
        visibleTerminalIds={[`panel-${threadId}`]}
        resolvedActiveTerminalId={`panel-${threadId}`}
        terminalLabelById={new Map()}
        focusRequestId={0}
        resizeEpoch={0}
        drawerHeight={320}
        keybindings={[]}
        onActiveTerminalChange={() => undefined}
        onCloseTerminal={() => undefined}
        onAddTerminalContext={() => undefined}
      />
    </div>
  );
  const screen = await render(<Switcher initial={panel("a")} />);
  const first = await settledView();
  swap(panel("b"));
  await expect.poll(() => instances().length).toBe(2);
  swap(panel("a"));
  await expect.poll(() => first.element?.closest("[data-terminal-view-slot]")).not.toBeNull();
  expect(text(first)).toContain("prompt a/panel-a");
  expect(instances()).toHaveLength(2);
  expect(mocks.open.mock.calls.map(([input]) => input.terminalId)).toEqual(["panel-a", "panel-b"]);
  await screen.unmount();
});

it("parks a cold restorable view and restores the identical screen from the host", async () => {
  mocks.restorable = true;
  mocks.screenText = "PARKED SCREEN\r\n$ ";
  const screen = await render(<Switcher initial={<Pane threadId="a" />} />);
  const terminal = await settledView();
  await expect.poll(() => text(terminal)).toBe("PARKED SCREEN\n$");
  const before = text(terminal);
  swap(
    <>
      {["b", "c", "d", "e"].map((thread) => (
        <Pane key={thread} threadId={thread} />
      ))}
    </>,
  );
  await expect.poll(() => terminalViewRegistry.viewState("a", "pane")).toBe("warm");
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 31_000);
  terminalViewRegistry.runParkCheck();
  expect(terminalViewRegistry.viewState("a", "pane")).toBe("parked");
  await expect.poll(() => terminal.element?.isConnected ?? false).toBe(false);
  swap(<Pane threadId="a" />);
  await expect.poll(() => terminalViewRegistry.viewState("a", "pane")).toBe("attached");
  const restored = instances().at(-1)!;
  expect(restored).not.toBe(terminal);
  await expect.poll(() => text(restored)).toBe(before);
  await screen.unmount();
});

it("disposes the least recently used unrestorable view past the cap and replays its history", async () => {
  const threads = Array.from({ length: 13 }, (_, index) => `t${index}`);
  seedPanes(Object.fromEntries(["a", ...threads].map((thread) => [thread, ["pane"]])));
  const screen = await render(<Switcher initial={<Pane threadId="a" />} />);
  const first = await settledView();
  expect(text(first)).toContain("prompt a/pane");
  swap(
    <>
      {threads.map((thread) => (
        <Pane key={thread} threadId={thread} />
      ))}
    </>,
  );
  // Thirteen attached views plus the released one exceed the cap of 12: "a" goes first.
  await expect.poll(() => terminalViewRegistry.viewState("a", "pane")).toBeNull();
  await expect.poll(() => first.element?.isConnected ?? false).toBe(false);
  swap(<Pane threadId="a" />);
  await expect.poll(() => terminalViewRegistry.viewState("a", "pane")).toBe("attached");
  const restored = instances().at(-1)!;
  expect(restored).not.toBe(first);
  await expect.poll(() => text(restored)).toContain("prompt a/pane");
  expect(mocks.open.mock.calls.filter(([input]) => input.threadId === "a")).toHaveLength(2);
  await screen.unmount();
});
