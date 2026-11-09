import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadMoreProjectCatalog, runBoundedBootstrap } from "./-__root.bounded-bootstrap";
import { useStore } from "../stores/main";
import {
  createProjectGateApi,
  resetProjectGateStore,
  deferredProjectPage,
  emptyPage,
  otherProjectId,
} from "../components/chat/view/ThreadProjectGate.test-helpers";

const cursor = { lastUsedAt: "2026-11-08T00:00:00.000Z", projectId: otherProjectId };
beforeEach(() => {
  resetProjectGateStore();
  useStore.setState({ projectCatalogCursorByScope: { local: cursor, remote: cursor } });
});
afterEach(() => vi.useRealTimers());

it.each([
  ["failure", "success"],
  ["failure", "failure"],
  ["timeout", "success"],
  ["timeout", "failure"],
] as const)(
  "releases pagination ownership on bootstrap %s and fences late page %s",
  async (bootstrapOutcome, pageOutcome) => {
    vi.useFakeTimers();
    const pages = createProjectGateApi();
    const local = deferredProjectPage();
    const remote = deferredProjectPage();
    pages.orchestration.getStartupProjectCatalog
      .mockReturnValueOnce(local.promise)
      .mockReturnValueOnce(remote.promise);
    const oldLoads = Promise.allSettled([
      loadMoreProjectCatalog({ api: pages.api, scope: "local" }),
      loadMoreProjectCatalog({ api: pages.api, scope: "remote" }),
    ]);
    expect(useStore.getState().projectCatalogLoadingByScope).toEqual({ local: true, remote: true });
    const bootstrap = createProjectGateApi();
    if (bootstrapOutcome === "failure") {
      bootstrap.orchestration.getSidebarThreadCatalog.mockRejectedValueOnce(new Error("offline"));
    } else {
      bootstrap.orchestration.getSidebarThreadCatalog.mockImplementationOnce(
        () => new Promise(() => {}),
      );
    }
    const result = runBoundedBootstrap({
      api: bootstrap.api,
      selectedThreadId: null,
      disposed: () => false,
      timeoutMs: 10,
    });
    const settled = Promise.allSettled([result]);
    // Reset at invalidation, not only on successful catalog installation.
    const loadingAtInvalidation = useStore.getState().projectCatalogLoadingByScope;
    await vi.advanceTimersByTimeAsync(11);
    expect((await settled)[0]?.status).toBe("rejected");

    const retryPage = deferredProjectPage();
    pages.orchestration.getStartupProjectCatalog.mockReturnValueOnce(retryPage.promise);
    const retry = loadMoreProjectCatalog({ api: pages.api, scope: "local" });
    expect(useStore.getState().projectCatalogLoadingByScope.local).toBe(true);
    if (pageOutcome === "success") {
      local.resolve(emptyPage);
      remote.resolve(emptyPage);
    } else {
      local.reject(new Error("obsolete page failure"));
      remote.reject(new Error("obsolete page failure"));
    }
    await oldLoads;
    const loadingAfterObsoletePages = useStore.getState().projectCatalogLoadingByScope;
    expect(useStore.getState().projectCatalogErrorByScope.local).toBeUndefined();
    expect(useStore.getState().projectCatalogCursorByScope.local).toEqual(cursor);
    retryPage.resolve(emptyPage);
    await retry;
    expect(useStore.getState().projectCatalogLoadingByScope.local).toBe(false);
    expect(useStore.getState().projectCatalogCursorByScope.local).toBeNull();
    expect(loadingAtInvalidation).toEqual({ local: false, remote: false });
    expect(loadingAfterObsoletePages).toEqual({ local: true, remote: false });
  },
);
