import "../../../index.css";
import { Terminal } from "@xterm/xterm";
import { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { resolveRemoteExecutionFailureStatus } from "../../../hooks/useRemoteExecutionAccessGate.shared";
import type { Project, Thread } from "../../../models/types";
import { useStore } from "../../../stores/main";
import { useRemoteAccessStore } from "../../../stores/remoteAccess/remoteAccess.store";
import { useTerminalStateStore } from "../../../stores/terminal/terminal.store";
import { ThreadRemoteTargetGate } from "../../chat/view/ThreadRemoteTargetGate";
import { TerminalViewport } from "../TerminalViewport";
import { TerminalViewParkingHost } from "./TerminalViewParkingHost";
import { terminalViewRegistry } from "./TerminalViewRegistry";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  api: {
    server: {
      verifyExecutionTarget: vi.fn(() => new Promise(() => undefined)),
      unlockSshPassword: vi.fn(),
      getRemoteAgentRestartStatus: vi.fn(),
    },
    terminal: {
      open: vi.fn(async (input: { threadId: string; terminalId: string }) => ({
        ...input,
        dropPathMode: "posix",
        cwd: "/repo",
        worktreePath: null,
        status: "running",
        pid: 1,
        history: "local prompt\r\n",
        exitCode: null,
        exitSignal: null,
        updatedAt: "2026-11-21T10:00:00.000Z",
      })),
      resize: vi.fn(async () => undefined),
      write: vi.fn(async () => undefined),
    },
  },
  settings: {
    terminalFontFamily: "system-monospace",
    terminalFontSize: 12,
    terminalGpuAcceleration: "off",
  },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => mocks.navigate,
  useParams: () => "local-thread",
}));
vi.mock("../../../rpc/nativeApi", () => ({ readNativeApi: () => mocks.api }));
vi.mock("../../../hooks/useSettings", () => ({ useSettings: () => mocks.settings }));
vi.mock("../../../lib/threadMaterialization", () => ({ ensureThreadMaterialized: vi.fn() }));

const SSH = "ssh:host=ice-2-kg&user=root&auth=password";
const LOCAL_PROJECT = ProjectId.makeUnsafe("gate-local");
const REMOTE_PROJECT = ProjectId.makeUnsafe("gate-remote");
const LOCAL = ThreadId.makeUnsafe("local-thread");
const REMOTE = ThreadId.makeUnsafe("remote-thread");
const project = (id: ProjectId, target: string) =>
  ({
    id,
    name: id,
    cwd: "/repo",
    workspaceExecutionTargetId: target,
    defaultModelSelection: null,
    scripts: [],
  }) as unknown as Project;
const thread = (id: ThreadId, projectId: ProjectId) =>
  ({ id, projectId, worktreePath: null, messages: [], activities: [] }) as unknown as Thread;

function Chat({ threadId }: { readonly threadId: ThreadId }) {
  const projectId = threadId === LOCAL ? LOCAL_PROJECT : REMOTE_PROJECT;
  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <TerminalViewParkingHost />
      <ThreadRemoteTargetGate threadId={threadId} projectId={projectId}>
        <div style={{ width: 640, height: 320 }}>
          <TerminalViewport
            threadId={threadId}
            terminalId="pane"
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
      </ThreadRemoteTargetGate>
    </div>
  );
}

afterEach(async () => {
  await cleanup();
  terminalViewRegistry.disposeAll();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

it("keeps a thread's view while ThreadRemoteTargetGate replaces ChatView for a gated thread", async () => {
  const opened = vi.spyOn(Terminal.prototype, "open");
  useStore.setState({
    projects: [project(LOCAL_PROJECT, "local"), project(REMOTE_PROJECT, SSH)],
    threads: [thread(LOCAL, LOCAL_PROJECT), thread(REMOTE, REMOTE_PROJECT)],
  });
  useRemoteAccessStore.setState({
    verifiedExecutionTargetIds: {},
    disconnectedExecutionTargetIds: {},
    disconnectedTargetsLoaded: true,
    executionTargetChecks: {},
  });
  useRemoteAccessStore
    .getState()
    .setExecutionTargetCheck(SSH, resolveRemoteExecutionFailureStatus("Connection timed out."));
  useTerminalStateStore.setState({
    terminalStateByThreadId: { [LOCAL]: { terminalIds: ["pane"] } },
    panelTerminalStateByThreadId: {},
  } as never);

  const screen = await render(<Chat threadId={LOCAL} />);
  await expect.poll(() => opened.mock.instances.length).toBe(1);
  const terminal = opened.mock.instances[0] as unknown as Terminal;
  await expect.poll(() => terminal.options.disableStdin).toBe(false);
  const element = terminal.element;

  await screen.rerender(<Chat threadId={REMOTE} />);
  await expect.element(page.getByText("Reconnecting to ice-2-kg…")).toBeVisible();
  expect(element?.closest("[data-terminal-view-holder]")).not.toBeNull();

  await screen.rerender(<Chat threadId={LOCAL} />);
  await expect.poll(() => element?.closest("[data-terminal-view-slot]")).not.toBeNull();
  expect(opened.mock.instances).toHaveLength(1);
  expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("local prompt");
  expect(mocks.api.terminal.open).toHaveBeenCalledOnce();
});
