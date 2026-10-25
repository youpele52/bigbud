import type { ReactElement, ReactNode, MouseEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ThreadId } from "@bigbud/contracts";
import { beforeEach, expect, it, vi } from "vitest";

import { SidebarThreadRow } from "./SidebarThreadRow";
import type { SidebarThreadRowProps } from "./SidebarThreadRow.types";
import { useTerminalStateStore } from "../../stores/terminal/terminal.store";
import type { TerminalStateStoreState } from "../../stores/terminal/terminal.store.types";
import {
  makeTerminalEvent,
  resetTerminalStore,
} from "../../stores/terminal/terminal.store.test.helpers";

const state = vi.hoisted(() => ({
  connecting: false,
  status: true,
  chatProvider: "codex" as "codex" | null,
  prClick: null as null | ((event: MouseEvent<HTMLButtonElement>) => void),
}));

vi.mock("../../stores/main", () => ({
  useSidebarThreadSummaryById: () => ({
    id: "thread",
    title: "Thread title",
    createdAt: "2026-10-01T00:00:00.000Z",
    session: {
      provider: state.chatProvider,
      orchestrationStatus: state.connecting ? "starting" : "running",
      updatedAt: "2026-10-01T00:00:00.000Z",
    },
  }),
}));
vi.mock("../../stores/ui", () => ({ useUiStateStore: () => undefined }));
vi.mock("../../stores/terminal", () => ({
  useTerminalStateStore: () => ["terminal"],
  selectThreadTerminalState: vi.fn(),
}));
vi.mock("../../stores/terminal/terminal.store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../stores/terminal/terminal.store")>();
  return {
    ...actual,
    useTerminalStateStore: Object.assign(
      <T,>(selector: (state: TerminalStateStoreState) => T) =>
        selector(actual.useTerminalStateStore.getState()),
      actual.useTerminalStateStore,
    ),
  };
});
vi.mock("./Sidebar.logic", () => ({
  resolveThreadRowClassName: () => "row",
  resolveThreadStatusPill: () =>
    state.connecting
      ? {
          label: "Getting Ready",
          colorClass: "text-info-foreground",
          dotClass: "bg-info-foreground",
          pulse: true,
        }
      : state.status
        ? {
            label: "Pending Approval",
            colorClass: "text-warning",
            dotClass: "bg-warning",
            pulse: false,
          }
        : null,
}));
vi.mock("./useSwipeRevealAction", () => ({
  useSwipeRevealAction: () => ({ revealOffset: 0 }),
}));
vi.mock("./SidebarThreadRow.actions", () => ({ SidebarThreadRowActions: () => null }));
vi.mock("../ui/sidebar", () => ({
  SidebarMenuSubButton: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarMenuSubItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipPopup: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ render }: { render: ReactElement<{ onClick: typeof state.prClick }> }) => {
    if (render.props.onClick) state.prClick = render.props.onClick;
    return render;
  },
}));

const threadId = ThreadId.makeUnsafe("thread");
const props: SidebarThreadRowProps = {
  threadId,
  orderedProjectThreadIds: [threadId],
  routeThreadId: null,
  selectedThreadIds: new Set(),
  showThreadJumpHints: false,
  jumpLabel: null,
  renamingThreadId: null,
  renamingTitle: "Thread title",
  setRenamingTitle: vi.fn(),
  onRenamingInputMount: vi.fn(),
  hasRenameCommitted: () => false,
  markRenameCommitted: vi.fn(),
  handleThreadClick: vi.fn(),
  navigateToThread: vi.fn(),
  handleMultiSelectContextMenu: vi.fn(async () => {}),
  handleThreadContextMenu: vi.fn(async () => {}),
  clearSelection: vi.fn(),
  commitRename: vi.fn(async () => {}),
  cancelRename: vi.fn(),
  branchThread: vi.fn(async () => {}),
  favoriteThreadIds: new Set(),
  toggleFavoriteThread: vi.fn(async () => {}),
  requestThreadDelete: vi.fn(async () => {}),
  openPrLink: vi.fn(),
  pr: {
    number: 42,
    title: "Change",
    state: "open",
    url: "https://example.com/pr/42",
    baseBranch: "main",
    headBranch: "feature",
  },
  automationThreadIds: new Set([threadId]),
};

beforeEach(() => {
  resetTerminalStore();
  state.connecting = false;
  state.status = true;
  state.chatProvider = "codex";
  state.prClick = null;
  vi.clearAllMocks();
});

it.each(["pi", "codex"] as const)(
  "keeps both provider icons before the title when the terminal uses %s",
  (provider) => {
    useTerminalStateStore
      .getState()
      .applyTerminalEvent(makeTerminalEvent("agentIdentity", { threadId, provider }));
    const html = renderToStaticMarkup(<SidebarThreadRow {...props} />);
    const terminalIndex = html.indexOf('data-slot="thread-terminal-provider-icon"');
    expect(terminalIndex).toBeGreaterThan(html.indexOf('data-slot="thread-provider-icon"'));
    expect(terminalIndex).toBeLessThan(html.indexOf("Thread title</span>"));
    expect(html.match(/data-slot="thread-provider-icon"/g)).toHaveLength(2);
  },
);

it("shows the terminal provider even when the thread has no chat session", () => {
  state.chatProvider = null;
  useTerminalStateStore
    .getState()
    .applyTerminalEvent(makeTerminalEvent("agentIdentity", { threadId, provider: "pi" }));
  const html = renderToStaticMarkup(<SidebarThreadRow {...props} />);
  expect(html).toContain('aria-label="Terminal provider: Pi"');
  expect(html.match(/data-slot="thread-provider-icon"/g)).toHaveLength(1);
});

it("keeps only the provider before the title, with PR first in the right-side indicators", () => {
  const html = renderToStaticMarkup(<SidebarThreadRow {...props} />);
  const titleIndex = html.indexOf("Thread title</span>");
  const providerIndex = html.indexOf('data-slot="thread-provider-icon"');
  const prIndex = html.indexOf('aria-label="#42 PR open: Change"');
  const statusIndex = html.indexOf("Pending Approval");
  const terminalIndex = html.indexOf('aria-label="Terminal process running"');
  expect(providerIndex).toBeGreaterThan(-1);
  expect(titleIndex).toBeGreaterThan(providerIndex);
  expect(prIndex).toBeGreaterThan(titleIndex);
  expect(statusIndex).toBeGreaterThan(prIndex);
  expect(html.indexOf('aria-label="Automation thread"')).toBeGreaterThan(statusIndex);
  expect(terminalIndex).toBeGreaterThan(html.indexOf('aria-label="Automation thread"'));
  expect(terminalIndex).toBeGreaterThan(statusIndex);
  expect(html.slice(prIndex, statusIndex)).toContain("text-success-foreground");
  const event = {} as MouseEvent<HTMLButtonElement>;
  state.prClick!(event);
  expect(props.openPrLink).toHaveBeenCalledWith(event, "https://example.com/pr/42");
});

it("places connecting and automation indicators after the title and PR while renaming", () => {
  state.status = false;
  state.connecting = true;
  const html = renderToStaticMarkup(<SidebarThreadRow {...props} renamingThreadId={threadId} />);
  const inputIndex = html.indexOf("<input");
  const prIndex = html.indexOf('aria-label="#42 PR open: Change"');
  expect(inputIndex).toBeGreaterThan(html.indexOf('data-slot="thread-provider-icon"'));
  expect(prIndex).toBeGreaterThan(inputIndex);
  expect(html.indexOf(">connecting</span>")).toBeGreaterThan(prIndex);
  expect(html.indexOf("Automation")).toBeGreaterThan(prIndex);
});
