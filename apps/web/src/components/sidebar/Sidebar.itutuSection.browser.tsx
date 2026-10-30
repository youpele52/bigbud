import "~/index.css";
import { ProjectId, ThreadId } from "@bigbud/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useItutuStore } from "../../stores/itutu/itutu.store";
import type { SidebarThreadSummary } from "../../models/types/app.types";
import type { SharedProjectItemProps } from "./Sidebar.types";
import { SidebarFixedActions } from "./Sidebar.actionsSection";
import { SidebarItutuSection } from "./Sidebar.itutuSection";
import { SidebarThreadRow } from "./SidebarThreadRow";

vi.mock("../../rpc/serverState", () => ({ useServerKeybindings: () => [] }));
vi.mock("../../rpc/nativeApi", () => ({ readNativeApi: () => undefined }));
vi.mock("../../stores/ui/search.store", () => ({
  useSearchStore: (selector: (state: { toggleSearchOpen: () => void }) => unknown) =>
    selector({ toggleSearchOpen: vi.fn() }),
}));
const fixtures = vi.hoisted(() => ({
  threads: {} as Record<string, SidebarThreadSummary>,
  terminalProvider: false,
}));

vi.mock("../../stores/main", () => ({
  useStore: (selector: (state: { sidebarThreadsById: object; projects: unknown[] }) => unknown) =>
    selector({ sidebarThreadsById: fixtures.threads, projects: [] }),
  useSidebarThreadSummaryById: (id: string) => fixtures.threads[id],
}));
vi.mock("../../stores/ui", () => ({ useUiStateStore: () => undefined }));
vi.mock("../../stores/terminal", () => ({
  useTerminalStateStore: () => [],
  selectThreadTerminalState: vi.fn(),
}));
vi.mock("./SidebarThreadTerminalProviderIcon", () => ({
  SidebarThreadTerminalProviderIcon: () =>
    fixtures.terminalProvider ? (
      <span data-slot="thread-terminal-provider-icon" className="inline-flex shrink-0">
        <svg className="size-3" />
      </span>
    ) : null,
}));
vi.mock("./Sidebar.itutu.catalog", () => ({
  useItutuCatalog: () => ({ pages: useItutuStore.getState().pages, loadMore: vi.fn() }),
}));
vi.mock("./Sidebar.itutu.actions", () => ({ moveThreadsToState: vi.fn() }));

const states = ["present", "needs-you", "later", "done"] as const;
const shared = {
  routeThreadId: ThreadId.makeUnsafe("present"),
  selectedThreadIds: new Set<ThreadId>(),
  favoriteThreadIds: new Set<ThreadId>(),
  threadJumpLabelById: new Map(),
  prByThreadId: new Map(),
  handleThreadClick: vi.fn(),
} as unknown as SharedProjectItemProps;

function makeThread(state: (typeof states)[number]): SidebarThreadSummary {
  return {
    id: ThreadId.makeUnsafe(state),
    projectId: ProjectId.makeUnsafe("project"),
    title: `Thread in ${state}`,
    interactionMode: "default",
    session: {
      provider: "codex",
      status: "ready",
      orchestrationStatus: "idle",
      createdAt: "2026-10-30T00:00:00.000Z",
      updatedAt: "2026-10-30T00:00:00.000Z",
    },
    createdAt: "2026-10-30T00:00:00.000Z",
    archivedAt: null,
    pinnedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    organization: { state, revision: 1, changedAt: null, snooze: null },
  };
}

const originalCollapsed = useItutuStore.getState().collapsedStates;
const originalDark = document.documentElement.classList.contains("dark");

beforeEach(() => {
  fixtures.terminalProvider = false;
  useItutuStore.setState({ collapsedStates: [] });
  fixtures.threads = Object.fromEntries(states.map((state) => [state, makeThread(state)]));
});

afterEach(() => {
  useItutuStore.setState({ collapsedStates: originalCollapsed });
  document.documentElement.classList.toggle("dark", originalDark);
});

it.each(["light", "dark"])(
  "aligns every Ìtútù group with the standard sidebar text column in %s mode",
  async (theme) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    const screen = await render(
      <div style={{ width: 280 }}>
        <SidebarFixedActions onNewChat={vi.fn()} newThreadShortcutLabel={null} />
        <SidebarItutuSection shared={shared} />
      </div>,
    );
    const reference = screen.getByText("New chat", { exact: true }).element();
    const textLeft = reference.getBoundingClientRect().left;
    expect(screen.getByText("Search", { exact: true }).element().getBoundingClientRect().left).toBe(
      textLeft,
    );

    for (const label of ["Present", "Needs you", "Later", "Done"]) {
      const heading = screen.getByText(label, { exact: true });
      await expect.element(heading).toBeVisible();
      expect(heading.element().getBoundingClientRect().left).toBe(textLeft);
      const state = states[["Present", "Needs you", "Later", "Done"].indexOf(label)]!;
      const row = screen.getByTestId(`thread-row-${state}`);
      await expect.element(row).toBeVisible();
      const provider = row.element().querySelector('[data-slot="thread-provider-icon"]')!;
      const location = row.element().querySelector(".text-muted-foreground\\/70 > svg")!;
      const title = screen.getByText(`Thread in ${state}`, { exact: true });
      expect(provider.getBoundingClientRect().left).toBe(textLeft);
      const titleBox = title.element().getBoundingClientRect();
      const providerBox = provider.getBoundingClientRect();
      expect(location.getBoundingClientRect().left).toBe(titleBox.left);
      expect(titleBox.left).toBeGreaterThan(textLeft);
      expect(providerBox.top + providerBox.height / 2).toBeCloseTo(
        titleBox.top + titleBox.height / 2,
        1,
      );
      expect(row.element().getBoundingClientRect().right).toBe(
        reference.closest("button")!.getBoundingClientRect().right,
      );
      const locationText = location.nextElementSibling!;
      expect(locationText.getBoundingClientRect().left).toBeGreaterThan(titleBox.left);
      await row.click();
      expect(shared.handleThreadClick).toHaveBeenLastCalledWith(expect.anything(), state, [state]);
      const button = screen.getByRole("button", { name: new RegExp(`^${label} `) });
      await expect.element(button).toHaveAttribute("aria-expanded", "true");
      await button.click();
      await expect.element(button).toHaveAttribute("aria-expanded", "false");
      await expect.element(row).not.toBeInTheDocument();
      expect(heading.element().getBoundingClientRect().left).toBe(textLeft);
    }
  },
);

it.each(["light", "dark"])(
  "keeps Projects provider icons aligned with the title in %s mode",
  async (theme) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    const id = ThreadId.makeUnsafe("present");
    const screen = await render(
      <ul style={{ width: 280 }}>
        <SidebarThreadRow
          {...shared}
          threadId={id}
          orderedProjectThreadIds={[id]}
          jumpLabel={null}
          pr={null}
        />
      </ul>,
    );
    const row = screen.getByTestId("thread-row-present");
    const provider = row.element().querySelector('[data-slot="thread-provider-icon"]')!;
    const title = screen.getByText("Thread in present", { exact: true });
    const providerBox = provider.getBoundingClientRect();
    const titleBox = title.element().getBoundingClientRect();
    expect(providerBox.top + providerBox.height / 2).toBe(titleBox.top + titleBox.height / 2);
    expect(row.element().querySelectorAll('[data-slot="thread-provider-icon"]')).toHaveLength(1);
    expect(row.element().getBoundingClientRect().height).toBe(28);
  },
);

it.each([true, false])(
  "keeps the location aligned with a terminal icon (chat provider=%s)",
  async (hasChatProvider) => {
    fixtures.terminalProvider = true;
    if (!hasChatProvider) {
      fixtures.threads.present = { ...fixtures.threads.present!, session: null };
    }
    const screen = await render(
      <div style={{ width: 280 }}>
        <SidebarItutuSection shared={shared} />
      </div>,
    );
    const row = screen.getByTestId("thread-row-present");
    const title = screen.getByText("Thread in present", { exact: true });
    const location = row.element().querySelector(".text-muted-foreground\\/70 > svg")!;
    expect(location.getBoundingClientRect().left).toBe(
      title.element().getBoundingClientRect().left,
    );
  },
);

it.each(["unknown", null] as const)(
  "does not leave a provider gap when the provider is %s",
  async (provider) => {
    const thread = fixtures.threads.present!;
    fixtures.threads.present = {
      ...thread,
      session: provider === null ? null : { ...thread.session!, provider },
    };
    const screen = await render(
      <div style={{ width: 280 }}>
        <SidebarItutuSection shared={shared} />
      </div>,
    );
    const row = screen.getByTestId("thread-row-present");
    expect(row.element().querySelector('[data-slot="thread-provider-icon"]')).toBeNull();
    const title = screen.getByText("Thread in present", { exact: true });
    const location = row.element().querySelector(".text-muted-foreground\\/70 > svg")!;
    expect(location.getBoundingClientRect().left).toBe(
      title.element().getBoundingClientRect().left,
    );
  },
);
