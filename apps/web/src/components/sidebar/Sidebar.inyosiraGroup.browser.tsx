import "~/index.css";
import { ProjectId, ThreadId } from "@bigbud/contracts";
import type { ThreadOrganizationState } from "@bigbud/contracts/orchestration/orchestration.organization.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { MouseEvent } from "react";

import type { SidebarThreadSummary } from "../../models/types/app.types";
import { useInyosiraStore } from "../../stores/inyosira/inyosira.store";
import { SidebarInyosiraSection } from "./Sidebar.inyosiraSection";
import type { SharedProjectItemProps } from "./Sidebar.types";

const fixtures = vi.hoisted(() => ({
  threads: {} as Record<string, SidebarThreadSummary>,
  total: {} as Partial<Record<ThreadOrganizationState, number>>,
  countUnavailable: false,
  requestCount: vi.fn(),
  refreshCounts: new Set<() => void>(),
  loadMore: vi.fn(),
}));

vi.mock("../../stores/main", () => ({
  useStore: (selector: (state: { sidebarThreadsById: object; projects: unknown[] }) => unknown) =>
    selector({ sidebarThreadsById: fixtures.threads, projects: [] }),
}));
vi.mock("../../rpc/nativeApi", () => {
  const readNativeApi = () => ({
    orchestration: {
      getOrganizationThreadSummaries: fixtures.requestCount,
      onDomainEvent: (_callback: unknown, options: { onResubscribe: () => void }) => {
        fixtures.refreshCounts.add(options.onResubscribe);
        return () => fixtures.refreshCounts.delete(options.onResubscribe);
      },
    },
  });
  return { readNativeApi, ensureNativeApi: readNativeApi };
});
vi.mock("./Sidebar.inyosira.catalog", () => ({
  useInyosiraCatalog: () => ({
    pages: useInyosiraStore((store) => store.pages),
    loadMore: fixtures.loadMore,
  }),
}));
vi.mock("./Sidebar.inyosira.actions", () => ({ moveThreadsToState: vi.fn() }));
vi.mock("./SidebarThreadRow", () => ({
  SidebarThreadRow: (props: {
    threadId: ThreadId;
    orderedProjectThreadIds: ThreadId[];
    handleThreadClick: (event: MouseEvent, id: ThreadId, ordered: ThreadId[]) => void;
  }) => (
    <li data-testid={`thread-row-${props.threadId}`}>
      <button
        onClick={(event) =>
          props.handleThreadClick(event, props.threadId, props.orderedProjectThreadIds)
        }
      >
        {props.threadId}
      </button>
    </li>
  ),
}));

const original = useInyosiraStore.getState();
const cursor = { updatedAt: "2026-11-03T12:00:00.000Z", threadId: ThreadId.makeUnsafe("cursor") };
const shared = {
  routeThreadId: null,
  threadJumpLabelById: new Map(),
  prByThreadId: new Map(),
  handleThreadClick: vi.fn(),
} as unknown as SharedProjectItemProps;

function seed(state: ThreadOrganizationState, loaded: number, total = loaded) {
  fixtures.total[state] = total;
  const ids = Array.from({ length: loaded }, (_, index) =>
    ThreadId.makeUnsafe(`${state}-${index}`),
  );
  for (const [index, id] of ids.entries()) {
    fixtures.threads[id] = {
      id,
      projectId: ProjectId.makeUnsafe("project"),
      title: id,
      interactionMode: "default",
      session: null,
      createdAt: new Date(Date.UTC(2026, 10, 3, 12, 0) - index * 60_000).toISOString(),
      archivedAt: null,
      pinnedAt: null,
      latestTurn: null,
      branch: null,
      worktreePath: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      organization: { state, revision: 0, changedAt: null, snooze: null },
    };
  }
  // Mirror the main store's immutable summary replacement when a page is appended.
  fixtures.threads = { ...fixtures.threads };
  useInyosiraStore.getState().setPage(state, {
    status: "loaded",
    nextCursor: loaded < total ? cursor : null,
  });
  for (const refresh of fixtures.refreshCounts) refresh();
  return ids;
}

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.threads = {};
  fixtures.total = {};
  fixtures.countUnavailable = false;
  fixtures.refreshCounts.clear();
  fixtures.requestCount
    .mockReset()
    .mockImplementation(({ state }) =>
      fixtures.countUnavailable
        ? Promise.reject(new Error("Disconnected"))
        : Promise.resolve({ totalCount: fixtures.total[state as ThreadOrganizationState] ?? 0 }),
    );
  fixtures.loadMore.mockReset();
  shared.routeThreadId = null;
  useInyosiraStore.setState({ ...original, collapsedStates: [], expandedThreadLists: [] });
});
afterEach(() => useInyosiraStore.setState(original));

const PAGING_CONTROL = /^(Show \d+ more|Show more|Show less|Loading\.\.\.)$/;

it.each(["present", "needs-you", "later", "done"] as const)(
  "mounts only four %s rows, reveals loaded rows without fetching, then offers the next page",
  async (state) => {
    const ids = seed(state, 8, 100);
    const screen = await render(<SidebarInyosiraSection shared={shared} />);
    await expect.element(screen.getByText("Show 4 more")).toBeVisible();
    for (const id of ids.slice(0, 4))
      await expect.element(screen.getByTestId(`thread-row-${id}`)).toBeVisible();
    for (const id of ids.slice(4))
      await expect.element(screen.getByTestId(`thread-row-${id}`)).not.toBeInTheDocument();
    await expect.element(screen.getByText("Show less")).not.toBeInTheDocument();

    await screen.getByText("Show 4 more").click();
    for (const id of ids)
      await expect.element(screen.getByTestId(`thread-row-${id}`)).toBeVisible();
    await expect.element(screen.getByText("Show 4 more")).toBeVisible();
    await screen.getByText("Show less").click();
    await expect.element(screen.getByTestId(`thread-row-${ids[7]}`)).not.toBeInTheDocument();
    expect(fixtures.loadMore).not.toHaveBeenCalled();
  },
);

it("keeps an active row beyond the preview visible and limits range selection to shown rows", async () => {
  const ids = seed("present", 8, 100);
  shared.routeThreadId = ids[7]!;
  const screen = await render(<SidebarInyosiraSection shared={shared} />);
  await expect.element(screen.getByText("Show 3 more")).toBeVisible();
  await screen.getByRole("button", { name: ids[7]!, exact: true }).click();
  expect(shared.handleThreadClick).toHaveBeenLastCalledWith(expect.anything(), ids[7], [
    ...ids.slice(0, 4),
    ids[7],
  ]);
  await screen.getByText("Show 3 more").click();
  await screen.getByText("Show less").click();
  await expect.element(screen.getByTestId(`thread-row-${ids[7]}`)).toBeVisible();
  await expect.element(screen.getByTestId(`thread-row-${ids[6]}`)).not.toBeInTheDocument();
});

it("fetches the next page from an expanded list, disables controls while loading, and counts down", async () => {
  seed("present", 8, 12);
  fixtures.loadMore.mockImplementation((state: ThreadOrganizationState) => {
    useInyosiraStore.getState().setPage(state, { status: "loading" });
  });
  const screen = await render(<SidebarInyosiraSection shared={shared} />);
  await screen.getByText("Show 4 more").click();
  expect(fixtures.loadMore).not.toHaveBeenCalled();
  await screen.getByText("Show 4 more").click();
  expect(fixtures.loadMore).toHaveBeenCalledExactlyOnceWith("present");
  await expect
    .element(screen.getByRole("button", { name: "Loading...", exact: true }))
    .toBeDisabled();
  await expect
    .element(screen.getByRole("button", { name: "Show less", exact: true }))
    .toBeDisabled();

  seed("present", 10, 12);
  await expect.element(screen.getByText("Show 2 more")).toBeVisible();
  await expect.element(screen.getByTestId("thread-row-present-9")).toBeVisible();
  seed("present", 12, 12);
  await expect.element(screen.getByText(/^Show \d+ more$/)).not.toBeInTheDocument();
  await screen.getByText("Show less").click();
  await expect.element(screen.getByText("Show 8 more")).toBeVisible();
});

it("keeps list expansion independent between groups and across accordion toggles", async () => {
  seed("present", 6);
  seed("later", 8);
  const screen = await render(<SidebarInyosiraSection shared={shared} />);
  await screen.getByText("Show 2 more").click();
  await expect.element(screen.getByTestId("thread-row-present-5")).toBeVisible();
  await expect.element(screen.getByTestId("thread-row-later-5")).not.toBeInTheDocument();
  await screen.getByRole("button", { name: /^Present / }).click();
  await expect.element(screen.getByTestId("thread-row-present-0")).not.toBeInTheDocument();
  await screen.getByRole("button", { name: /^Present / }).click();
  await expect.element(screen.getByTestId("thread-row-present-5")).toBeVisible();
  await expect.element(screen.getByText("Show 4 more")).toBeVisible();
});

it("does not show controls for empty or short fully loaded groups", async () => {
  seed("present", 4);
  const screen = await render(<SidebarInyosiraSection shared={shared} />);
  await expect.element(screen.getByText(PAGING_CONTROL)).not.toBeInTheDocument();
});

it("does not offer empty paging controls when an authoritative total exhausts an older cursor", async () => {
  seed("present", 4);
  useInyosiraStore.getState().setPage("present", { nextCursor: cursor });
  const screen = await render(<SidebarInyosiraSection shared={shared} />);
  await expect
    .element(screen.getByRole("button", { name: /^Present / }))
    .toHaveTextContent("Present(4)");
  await expect.element(screen.getByText(PAGING_CONTROL)).not.toBeInTheDocument();
});

it.each([4, 6])(
  "keeps expansion available with a stale total of %i through debounce and a pending refresh",
  async (previousTotal) => {
    seed("present", 4, previousTotal);
    const screen = await render(<SidebarInyosiraSection shared={shared} />);
    await expect
      .element(screen.getByRole("button", { name: /^Present / }))
      .toHaveTextContent(`Present(${previousTotal})`);
    let resolveCount!: (page: { totalCount: number }) => void;
    fixtures.requestCount.mockImplementation(({ state }) =>
      state === "present"
        ? new Promise((resolve) => {
            resolveCount = resolve;
          })
        : Promise.resolve({ totalCount: 0 }),
    );
    const ids = seed("present", 8, 12);
    const showMore = screen.getByRole("button", { name: "Show 4 more", exact: true });
    await expect.element(showMore).toBeVisible();
    await expect.poll(() => resolveCount).toBeTypeOf("function");
    await showMore.click();
    for (const id of ids)
      await expect.element(screen.getByTestId(`thread-row-${id}`)).toBeVisible();
    // Expanded: the next page is offered, labelled 4 while the stale total is unknown.
    await expect.element(showMore).toBeVisible();
    await screen.getByText("Show less").click();
    await expect.element(screen.getByTestId(`thread-row-${ids[7]}`)).not.toBeInTheDocument();
    expect(fixtures.loadMore).not.toHaveBeenCalled();

    resolveCount({ totalCount: 12 });
    await expect
      .element(screen.getByRole("button", { name: /^Present / }))
      .toHaveTextContent("Present(12)");
    await screen.getByText("Show 4 more").click();
    await expect.element(screen.getByText("Show 4 more")).toBeVisible();
    await screen.getByText("Show less").click();
    await expect.element(screen.getByText("Show 4 more")).toBeVisible();
  },
);

it("does not invent counts when totals are unavailable", async () => {
  seed("present", 8, 100);
  fixtures.countUnavailable = true;
  const screen = await render(<SidebarInyosiraSection shared={shared} />);
  await screen.getByRole("button", { name: "Show 4 more", exact: true }).click();
  await expect
    .element(screen.getByRole("button", { name: "Show 4 more", exact: true }))
    .toBeVisible();
});

it("offers retry after a failed first page even without a cursor or an expanded list", async () => {
  useInyosiraStore.getState().setPage("present", { status: "error", nextCursor: null });
  const screen = await render(<SidebarInyosiraSection shared={shared} />);
  await screen.getByText("Couldn't load threads. Try again").click();
  expect(fixtures.loadMore).toHaveBeenCalledExactlyOnceWith("present");
});
