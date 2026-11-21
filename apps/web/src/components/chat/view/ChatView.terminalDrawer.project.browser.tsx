import "../../../index.css";
import { Terminal } from "@xterm/xterm";
import { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { TerminalDrawerSwitchFixture } from "./ChatView.terminalDrawer.fixture";
import { ThreadProjectGate } from "./ThreadProjectGate";
import {
  chatsPage,
  deferredProjectPage,
  emptyPage,
  resetProjectGateStore,
} from "./ThreadProjectGate.test-helpers";
import { retainProjectDependency } from "../../../lib/projectDependencies";
import { useStore } from "../../../stores/main";
import { useTerminalStateStore } from "../../../stores/terminal/terminal.store";
import { resetTerminalStore } from "../../../stores/terminal/terminal.store.test.helpers";

const projectIdByThread = vi.hoisted(() => ({ a: "dependency-a", b: "dependency-b" }));
const mocks = vi.hoisted(() => ({
  open: vi.fn(async (input: { threadId: string; terminalId: string; cwd?: string }) => ({
    ...input,
    dropPathMode: "posix",
    cwd: `/workspace/${input.threadId}`,
    worktreePath: null,
    status: "running",
    pid: 1,
    history: "synthetic prompt\r\n",
    exitCode: null,
    exitSignal: null,
    updatedAt: "2026-11-21T00:00:00.000Z",
  })),
  getStartupProjectCatalog: vi.fn(),
  resize: vi.fn(async () => undefined),
  write: vi.fn(async () => undefined),
  settings: {
    terminalFontFamily: "system-monospace",
    terminalFontSize: 12,
    terminalGpuAcceleration: "off",
  },
}));
vi.mock("../../../rpc/nativeApi", () => ({
  readNativeApi: () => ({
    terminal: mocks,
    orchestration: { getStartupProjectCatalog: mocks.getStartupProjectCatalog },
  }),
}));
vi.mock("../../../rpc/serverState", async (original) => ({
  ...(await original<typeof import("../../../rpc/serverState")>()),
  useServerSettings: () => ({ defaultChatCwd: "~/Documents" }),
}));
vi.mock("../../../hooks/useSettings", () => ({ useSettings: () => mocks.settings }));
vi.mock("~/config/env", () => ({ isElectron: false }));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useParams: () => "a",
}));
// Threads are synthetic; projects, eviction and the real drawer hook use the real stores.
vi.mock("../../../stores/main", async (original) => {
  const threads = Object.fromEntries(
    Object.entries(projectIdByThread).map(([id, projectId]) => [
      id,
      { id, projectId, worktreePath: null, workspaceExecutionTargetId: "local" },
    ]),
  );
  return {
    ...(await original<typeof import("../../../stores/main")>()),
    useThreadById: (threadId: string) => threads[threadId],
  };
});

const projectA = ProjectId.makeUnsafe(projectIdByThread.a);
const projectB = ProjectId.makeUnsafe(projectIdByThread.b);

function lookup(projectId: ProjectId) {
  return {
    ...chatsPage,
    projects: [{ ...chatsPage.projects[0]!, id: projectId, workspaceRoot: `/${projectId}` }],
  };
}

const route = (projectId: ProjectId, active: "a" | "b") => (
  <ThreadProjectGate projectId={projectId}>
    <TerminalDrawerSwitchFixture active={active} />
  </ThreadProjectGate>
);

const hasProject = (projectId: ProjectId) =>
  useStore.getState().projects.some((project) => project.id === projectId);

beforeEach(() => {
  resetProjectGateStore();
  resetTerminalStore();
  vi.clearAllMocks();
  for (const id of ["a", "b"]) {
    useTerminalStateStore.getState().setTerminalOpen(ThreadId.makeUnsafe(id), true);
  }
  // Both projects are lookups only, as after a bounded bootstrap outside the first page.
  useStore.getState().mergeProjectCatalogPage(lookup(projectA));
  useStore.getState().mergeProjectCatalogPage(lookup(projectB));
});
afterEach(() => {
  vi.restoreAllMocks();
  resetTerminalStore();
});

it("keeps a hidden drawer and its emulator alive when the route releases its dependency-only project", async () => {
  const opened = vi.spyOn(Terminal.prototype, "open");
  const disposed = vi.spyOn(Terminal.prototype, "dispose");
  // The route gate retains only the active thread's project.
  let releaseRoute = retainProjectDependency(projectB);
  const screen = await render(<TerminalDrawerSwitchFixture active="b" />);
  try {
    await expect.poll(() => opened.mock.instances.length).toBe(2);
    const hiddenThreadTerminal = opened.mock.instances[1] as Terminal;

    // Switch to thread "a" in another project: the gate moves its retention to project A.
    const nextRelease = retainProjectDependency(projectA);
    releaseRoute();
    releaseRoute = nextRelease;
    await screen.rerender(<TerminalDrawerSwitchFixture active="a" />);

    expect(hasProject(projectB)).toBe(true);
    const hidden = screen.container.querySelector<HTMLElement>(
      '[data-terminal-presentation="hidden"]',
    );
    expect(hidden?.querySelector(".xterm")).not.toBeNull();
    expect(disposed).not.toHaveBeenCalled();
    expect(hiddenThreadTerminal.element?.isConnected).toBe(true);

    // Explicit loss of the project (e.g. recovery replacing the catalog) still keeps the view.
    useStore.setState((state) => ({
      projects: state.projects.filter((project) => project.id !== projectB),
    }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(
      screen.container.querySelector('[data-terminal-presentation="hidden"] .xterm'),
    ).not.toBeNull();
    expect(disposed).not.toHaveBeenCalled();
    expect(opened).toHaveBeenCalledTimes(2);
    // Each drawer launched in its own project's cwd; eviction did not rebind either.
    await expect
      .poll(() => mocks.open.mock.calls.map(([input]) => input.cwd).sort())
      .toEqual([`/${projectA}`, `/${projectB}`]);
  } finally {
    releaseRoute();
    await screen.unmount();
  }
  // Releasing the last owner lets the bounded cache evict the lookup as before.
  expect(useStore.getState().projectDependencyRefCounts).toEqual({});
  expect(hasProject(projectB)).toBe(false);
});

it("keeps hidden drawers mounted while the route gate loads the next thread's project", async () => {
  const opened = vi.spyOn(Terminal.prototype, "open");
  const disposed = vi.spyOn(Terminal.prototype, "dispose");
  const pending = deferredProjectPage();
  mocks.getStartupProjectCatalog.mockImplementation(({ scope }: { scope: string }) =>
    scope === "local" ? pending.promise : Promise.resolve(emptyPage),
  );
  const screen = await render(route(projectB, "b"));
  try {
    await expect.poll(() => opened.mock.instances.length).toBe(2);
    // Thread "a"'s project is no longer in the store, so the gate must load it first.
    useStore.setState((state) => ({
      projects: state.projects.filter((project) => project.id !== projectA),
    }));
    await screen.rerender(route(projectA, "a"));
    await expect.element(screen.getByRole("status")).toHaveTextContent("Loading chat project");
    expect(screen.container.querySelectorAll(".xterm")).toHaveLength(2);
    expect(disposed).not.toHaveBeenCalled();

    pending.resolve(lookup(projectA));
    await expect
      .poll(() => screen.container.querySelector('[data-terminal-presentation="fill"]'))
      .not.toBeNull();
    expect(screen.container.querySelectorAll(".xterm")).toHaveLength(2);
    expect(opened).toHaveBeenCalledTimes(2);
    expect(disposed).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
  }
});
