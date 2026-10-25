import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { Terminal } from "@xterm/xterm";
import type { TerminalEvent } from "@bigbud/contracts/workspace/terminal.ts";
import type { TerminalSessionStreamItem } from "@bigbud/contracts/workspace/terminal.stream.ts";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { publishTerminalOutput } from "./TerminalOutputStream";
import { TerminalSessionFixture } from "./TerminalViewport.session.fixture";
import { EventRouter } from "../../routes/-__root.logic";
import { selectTerminalEventEntries, useTerminalStateStore } from "../../stores/terminal";

const mocks = vi.hoisted(() => ({
  open: vi.fn(async () => ({
    threadId: "terminal-fixture",
    terminalId: "synthetic",
    dropPathMode: "posix",
    cwd: "/synthetic",
    worktreePath: null,
    status: "running",
    pid: 1,
    history: "\x1b[?1049hTUI",
    exitCode: null,
    exitSignal: null,
    updatedAt: "2026-10-10T00:00:00.000Z",
  })),
  write: vi.fn(async () => undefined),
  resize: vi.fn(async () => undefined),
  onEvent: vi.fn((_listener: (event: TerminalEvent) => void) => () => undefined),
  subscribeSession: vi.fn(
    (_input: unknown, listener: (item: TerminalSessionStreamItem) => void) => {
      queueMicrotask(() => listener({ type: "subscribed", subscriptionId: "fixture" }));
      return () => undefined;
    },
  ),
  ackOutput: vi.fn(async () => undefined),
  onDomainEvent: vi.fn(() => () => undefined),
  settings: { enableThinkingStreaming: false },
  queryClient: {},
  navigate: vi.fn(),
  newThread: vi.fn(),
}));
vi.mock("../../rpc/nativeApi", () => ({
  readNativeApi: () => ({ terminal: mocks, orchestration: mocks }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => mocks.navigate,
  useLocation: () => "/",
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => mocks.queryClient,
}));
vi.mock("../../rpc/serverState", () => ({
  getServerConfig: () => null,
  useServerConfig: () => null,
  useServerSettings: () => mocks.settings,
  getServerConfigUpdatedNotification: () => null,
  useServerWelcomeSubscription: () => undefined,
  useServerConfigUpdatedSubscription: () => undefined,
}));
vi.mock("../../hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({ handleNewThread: mocks.newThread }),
  resolveNewChatOptions: () => ({}),
}));
vi.mock("../../hooks/useSettings", () => ({
  migrateLocalSettingsToServer: () => undefined,
  persistServerSettings: () => undefined,
}));
vi.mock("../../routes/-__root.recovery", () => ({
  createEventRouterRecovery: () => ({ cancel: () => undefined }),
}));

it("scoped stream preserves every numbered event in a 1000-event task while the root keeps its bounded ring; fonts and stale work preserve identity", async () => {
  let terminal: Terminal | null = null;
  const onTerminal = (next: Terminal | null) => {
    terminal = next;
  };
  const screen = await render(
    <>
      <EventRouter />
      <TerminalSessionFixture fontSize={12} onTerminal={onTerminal} />
    </>,
  );
  try {
    await expect.poll(() => screen.container.textContent).toContain("ready");
    const original = terminal!;
    const dispose = vi.spyOn(original, "dispose");
    const rootReceive = mocks.onEvent.mock.calls.at(-1)![0];
    const viewReceive = mocks.subscribeSession.mock.calls.at(-1)![1];
    // Enter through both real native-API callbacks: the root feed and the view's scoped stream.
    const receive = (event: TerminalEvent) => {
      rootReceive(event);
      viewReceive(event);
    };
    const base = {
      threadId: ThreadId.makeUnsafe("terminal-fixture"),
      terminalId: "synthetic",
      createdAt: "2026-10-10T00:00:01.000Z",
    };
    receive({ ...base, type: "output", data: "\x1b[?1049l\x1bc" });
    const numbered = Array.from({ length: 1000 }, (_, i) => `N${String(i).padStart(4, "0")}`);
    // One JS task, above the 200-entry UI ring, not the transient registry's publication helper.
    for (const line of numbered)
      receive({
        ...base,
        type: "output",
        data: `${line}\r\n`,
      });
    await expect
      .poll(
        () =>
          Array.from({ length: 1000 }, (_, i) =>
            original.buffer.active.getLine(i)?.translateToString(true),
          ),
        { timeout: 15000 },
      )
      .toEqual(numbered);
    const entries = selectTerminalEventEntries(
      useTerminalStateStore.getState().terminalEventEntriesByKey,
      base.threadId,
      base.terminalId,
    );
    expect(entries).toHaveLength(200);
    expect(entries.at(-1)?.event).toMatchObject({ type: "output", data: "N0999\r\n" });
    const buffer = original.buffer.active;
    await screen.rerender(
      <>
        <EventRouter />
        <TerminalSessionFixture fontSize={16} onTerminal={onTerminal} />
      </>,
    );
    await expect.poll(() => original.options.fontSize).toBe(16);
    expect(terminal).toBe(original);
    expect(original.buffer.active).toBe(buffer);
    expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
    await screen.unmount();
    expect(dispose).toHaveBeenCalledOnce();
    publishTerminalOutput({
      type: "output",
      threadId: "terminal-fixture",
      terminalId: "synthetic",
      data: "after-disposal",
      createdAt: "2026-10-10T00:00:02.000Z",
    });
    expect(mocks.write).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
  }
});
