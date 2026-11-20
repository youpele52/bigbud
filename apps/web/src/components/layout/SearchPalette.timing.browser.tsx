import "../../index.css";

import { ThreadId } from "@bigbud/contracts";
import type { SystemSearchQueryInput } from "@bigbud/contracts/search/systemSearch.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

interface QueryCall {
  readonly input: SystemSearchQueryInput;
  readonly signal: AbortSignal;
}

const mocks = vi.hoisted(() => ({
  searchMessages: vi.fn(),
  getProjectCatalog: vi.fn(),
  calls: [] as QueryCall[],
}));

vi.mock("~/rpc/nativeApi", () => ({
  ensureNativeApi: () => ({
    orchestration: {
      searchConversationMessages: mocks.searchMessages,
      getStartupProjectCatalog: mocks.getProjectCatalog,
    },
    terminal: { search: async () => ({ hits: [] }) },
  }),
  readNativeApi: () => ({
    search: {
      query: (input: SystemSearchQueryInput, _onUpdate: unknown, signal: AbortSignal) =>
        new Promise<void>(() => mocks.calls.push({ input, signal })),
    },
  }),
}));

import { useStore } from "../../stores/main";
import { makeThread } from "../../stores/main/main.store.test.helpers";
import { useSearchStore } from "../../stores/ui";
import { SearchPaletteDialogContent } from "./SearchPalette.content";

const THREAD_ID = ThreadId.makeUnsafe("timing-thread");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const slowCalls = () => mocks.calls.filter((call) => !call.input.tiers.includes("currentProject"));

async function renderPalette() {
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <SearchPaletteDialogContent activeThreadId={THREAD_ID} />,
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("Mod+F source timing (parity with Mod+P)", () => {
  beforeEach(() => {
    mocks.calls.length = 0;
    mocks.searchMessages
      .mockReset()
      .mockResolvedValue({ status: "ready", projectionSequence: 1, hits: [] });
    mocks.getProjectCatalog
      .mockReset()
      .mockResolvedValue({ projects: [], projectionSequence: 1, remainingCount: 0 });
    useStore.setState({ projects: [], threads: [makeThread({ id: THREAD_ID, deletingAt: null })] });
    useSearchStore.setState({ searchOpen: true, focusRequest: null });
  });

  afterEach(() => {
    useSearchStore.setState({ searchOpen: false, focusRequest: null });
    useStore.setState({ projects: [], threads: [] });
  });

  it("asks fast tiers at once and slow tiers only after 150 ms without typing", async () => {
    await renderPalette();
    await page.getByPlaceholder("Search").fill("needle");
    // Fast tiers: current thread messages and the current project's files, no debounce.
    await vi.waitFor(
      () => {
        expect(mocks.searchMessages).toHaveBeenCalledWith(
          expect.objectContaining({ query: "needle", currentThreadId: THREAD_ID }),
        );
        expect(mocks.calls.map((call) => call.input.tiers)).toContainEqual(["currentProject"]);
      },
      { timeout: 100, interval: 5 },
    );
    expect(slowCalls()).toHaveLength(0);
    await sleep(80);
    expect(slowCalls()).toHaveLength(0);
    await sleep(150);
    expect(slowCalls()).toHaveLength(1);
    expect(slowCalls()[0]!.input).toMatchObject({ query: "needle" });
    expect(slowCalls()[0]!.input.tiers).toEqual(
      expect.arrayContaining(["otherProjectFiles", "remoteOutsideProjects"]),
    );
  });

  it("restarts only the slow debounce on the next keystroke and cancels superseded queries", async () => {
    await renderPalette();
    await page.getByPlaceholder("Search").fill("needle");
    await sleep(200);
    const [fast, slow] = [mocks.calls[0]!, slowCalls()[0]!];
    await page.getByPlaceholder("Search").fill("needles");
    await vi.waitFor(() => expect(fast.signal.aborted).toBe(true), { timeout: 100, interval: 5 });
    expect(mocks.calls.at(-1)!.input).toMatchObject({
      query: "needles",
      tiers: ["currentProject"],
    });
    expect(slow.signal.aborted).toBe(false);
    await sleep(200);
    expect(slow.signal.aborted).toBe(true);
    expect(slowCalls().at(-1)!.input).toMatchObject({ query: "needles" });
  });
});
