import "~/index.css";
import { ProjectId, ThreadId } from "@bigbud/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useInyosiraStore } from "../../stores/inyosira/inyosira.store";
import type { SidebarThreadSummary } from "../../models/types/app.types";
import type { SharedProjectItemProps } from "./Sidebar.types";
import { SidebarFixedActions } from "./Sidebar.actionsSection";
import { SidebarInyosiraSection } from "./Sidebar.inyosiraSection";
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
vi.mock("./Sidebar.inyosira.catalog", () => ({
  useInyosiraCatalog: () => ({ pages: useInyosiraStore.getState().pages, loadMore: vi.fn() }),
}));
vi.mock("./Sidebar.inyosira.actions", () => ({ moveThreadsToState: vi.fn() }));

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

const originalCollapsed = useInyosiraStore.getState().collapsedStates;
const originalExpanded = useInyosiraStore.getState().expandedThreadLists;
const originalPages = useInyosiraStore.getState().pages;
const originalDark = document.documentElement.classList.contains("dark");

beforeEach(() => {
  fixtures.terminalProvider = false;
  useInyosiraStore.setState({ collapsedStates: [], expandedThreadLists: [] });
  fixtures.threads = Object.fromEntries(states.map((state) => [state, makeThread(state)]));
});

afterEach(() => {
  useInyosiraStore.setState({
    collapsedStates: originalCollapsed,
    expandedThreadLists: originalExpanded,
    pages: originalPages,
  });
  document.documentElement.classList.toggle("dark", originalDark);
});

it.each(["light", "dark"])(
  "keeps headings aligned and insets Inyosira thread lists in %s mode",
  async (theme) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    const screen = await render(
      <div style={{ width: 280 }}>
        <SidebarFixedActions onNewChat={vi.fn()} newThreadShortcutLabel={null} />
        <SidebarInyosiraSection shared={shared} />
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
      expect(provider.getBoundingClientRect().left).toBeCloseTo(textLeft + 8, 1);
      const titleBox = title.element().getBoundingClientRect();
      const providerBox = provider.getBoundingClientRect();
      expect(location.getBoundingClientRect().left).toBe(titleBox.left);
      expect(titleBox.left).toBeGreaterThan(textLeft);
      expect(providerBox.top + providerBox.height / 2).toBeCloseTo(
        titleBox.top + titleBox.height / 2,
        1,
      );
      expect(row.element().getBoundingClientRect().right).toBeCloseTo(
        reference.closest("button")!.getBoundingClientRect().right - 8,
        1,
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

it("keeps preview and paging controls outside the thread-only horizontal inset", async () => {
  useInyosiraStore.getState().setPage("present", {
    status: "loaded",
    nextCursor: { updatedAt: "2026-11-03T12:00:00.000Z", threadId: ThreadId.makeUnsafe("cursor") },
  });
  const screen = await render(
    <div style={{ width: 280 }}>
      <SidebarInyosiraSection shared={shared} />
    </div>,
  );
  const row = screen.getByTestId("thread-row-present").element();
  const provider = row.querySelector('[data-slot="thread-provider-icon"]')!;
  const list = row.closest('[data-slot="sidebar-menu-sub"]')!;
  expect(getComputedStyle(list).paddingLeft).toBe("0px");
  expect(getComputedStyle(list).paddingRight).toBe("0px");
  const threadItem = row.closest("[data-thread-item]")!;
  expect(getComputedStyle(threadItem).paddingLeft).toBe("8px");
  expect(getComputedStyle(threadItem).paddingRight).toBe("8px");
  const checkControl = (button: Element) => {
    expect(button.getBoundingClientRect().left).toBe(row.getBoundingClientRect().left - 8);
    expect(button.getBoundingClientRect().right).toBe(row.getBoundingClientRect().right + 8);
    expect(button.querySelector("span")!.getBoundingClientRect().left).toBe(
      provider.getBoundingClientRect().left - 8,
    );
  };
  const seeMore = screen.getByRole("button", { name: "See more", exact: true });
  await expect.element(seeMore).toBeVisible();
  checkControl(seeMore.element());
  await seeMore.click();
  checkControl(screen.getByRole("button", { name: "Show less", exact: true }).element());
  checkControl(screen.getByRole("button", { name: "Load more", exact: true }).element());
});

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
        <SidebarInyosiraSection shared={shared} />
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

it.each([
  [true, false],
  [true, true],
  [false, false],
  [false, true],
])("aligns snoozed rows (provider=%s, terminal=%s)", async (hasProvider, hasTerminal) => {
  fixtures.terminalProvider = hasTerminal;
  const thread = fixtures.threads.later!;
  fixtures.threads.later = {
    ...thread,
    session: hasProvider ? thread.session : null,
    organization: {
      ...thread.organization!,
      snooze: { id: "snooze-1", until: "2026-11-03T12:00:00.000Z" },
    },
  };
  const screen = await render(
    <div style={{ width: 280 }}>
      <SidebarInyosiraSection shared={shared} />
    </div>,
  );
  const row = screen.getByTestId("thread-row-later");
  const clock = row.getByRole("img", { name: /^Snoozed until / });
  await expect.element(clock).toBeVisible();
  const provider = row.element().querySelector('[data-slot="thread-provider-icon"]');
  const terminalProvider = row
    .element()
    .querySelector('[data-slot="thread-terminal-provider-icon"]');
  expect(clock.element().parentElement?.firstElementChild).toBe(clock.element());
  if (hasProvider) expect(clock.element().nextElementSibling).toBe(provider);
  if (hasTerminal) {
    expect((provider ?? clock.element()).nextElementSibling).toBe(terminalProvider);
  }
  const titleBox = screen
    .getByText("Thread in later", { exact: true })
    .element()
    .getBoundingClientRect();
  const clockBox = clock.element().getBoundingClientRect();
  expect(clockBox.top + clockBox.height / 2).toBeCloseTo(titleBox.top + titleBox.height / 2, 1);
  const location = row.element().querySelector(".text-muted-foreground\\/70 > svg")!;
  expect(location.getBoundingClientRect().left).toBe(titleBox.left);
  expect(
    screen
      .getByTestId("thread-row-present")
      .element()
      .querySelector('[data-slot="thread-snooze-icon"]'),
  ).toBeNull();

  fixtures.threads.later = thread;
  await screen.rerender(
    <div style={{ width: 280 }}>
      <SidebarInyosiraSection shared={shared} />
    </div>,
  );
  await expect.element(clock).not.toBeInTheDocument();
});

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
        <SidebarInyosiraSection shared={shared} />
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
