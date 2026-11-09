import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hydrateSelectedThread, runBoundedBootstrap } from "./-__root.bounded-bootstrap";
import { useStore } from "../stores/main";
import {
  setThreadHydrationEventApplier,
  threadHydrationEventBuffer,
} from "../logic/orchestration/thread-hydration-events.logic";
import { makeEvent } from "../stores/main/main.store.test.helpers";
import {
  createProjectGateApi,
  resetProjectGateStore,
  recentId,
  chatsId,
} from "../components/chat/view/ThreadProjectGate.test-helpers";

beforeEach(() => {
  resetProjectGateStore();
  setThreadHydrationEventApplier(null);
});
afterEach(() => {
  vi.useRealTimers();
  threadHydrationEventBuffer.clear();
});
function blockedApi() {
  const fixture = createProjectGateApi();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const catalog = fixture.orchestration.getStartupProjectCatalog.getMockImplementation()!;
  fixture.orchestration.getStartupProjectCatalog.mockImplementation(async (input) => {
    await pending;
    const page = await catalog(input);
    return {
      ...page,
      projects: page.projects.map((project) =>
        Object.assign({}, project, { title: "Old bootstrap" }),
      ),
    };
  });
  return { ...fixture, release };
}

it("a timed-out bootstrap cannot overwrite the next successful baseline", async () => {
  vi.useFakeTimers();
  const old = blockedApi();
  const result = runBoundedBootstrap({
    api: old.api,
    selectedThreadId: null,
    disposed: () => false,
    timeoutMs: 20,
  });
  const rejected = expect(result).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(21);
  await rejected;
  const fresh = createProjectGateApi();
  await runBoundedBootstrap({ api: fresh.api, selectedThreadId: null, disposed: () => false });
  const projects = useStore.getState().projects;
  old.release();
  await vi.advanceTimersByTimeAsync(0);
  expect(useStore.getState().projects).toBe(projects);
});

it("an epoch reset revokes the active bootstrap before the next queued baseline", async () => {
  const old = blockedApi();
  const result = runBoundedBootstrap({
    api: old.api,
    selectedThreadId: null,
    disposed: () => false,
  });
  const rejected = expect(result).rejects.toThrow("superseded");
  useStore.getState().resetProjectCatalogEpoch("replacement-db");
  const fresh = createProjectGateApi();
  const next = runBoundedBootstrap({
    api: fresh.api,
    selectedThreadId: null,
    disposed: () => false,
  });
  old.release();
  await rejected;
  await next;
  expect(useStore.getState().projects.some((project) => project.name === "Old bootstrap")).toBe(
    false,
  );
});

it.each(["route-disposal", "external-disposal"] as const)(
  "releases owned hydration and buffered events after %s",
  async (mode) => {
    vi.useFakeTimers();
    const fresh = createProjectGateApi();
    await runBoundedBootstrap({
      api: fresh.api,
      selectedThreadId: recentId,
      disposed: () => false,
    });
    const old = blockedApi();
    let disposed = false;
    const result = runBoundedBootstrap({
      api: old.api,
      selectedThreadId: recentId,
      disposed: () => disposed,
      timeoutMs: 20,
    });
    const rejected = expect(result).rejects.toThrow(
      mode === "route-disposal" ? "superseded" : "timed out",
    );
    const event = makeEvent(
      "thread.meta-updated",
      { threadId: recentId, title: "Buffered live update", updatedAt: "2026-11-09T00:00:00.000Z" },
      { sequence: 30 },
    );
    expect(threadHydrationEventBuffer.bufferEvent(event)).toBe(true);
    if (mode === "route-disposal") {
      disposed = true;
      old.release();
    } else {
      disposed = true;
      await vi.advanceTimersByTimeAsync(21);
    }
    await rejected;
    expect(useStore.getState().threads.find((thread) => thread.id === recentId)?.title).toBe(
      "Buffered live update",
    );
    expect(useStore.getState().threadHydrationById[recentId]).toMatchObject({
      status: "failed",
      retry: { kind: "initial" },
    });
    expect(threadHydrationEventBuffer.bufferEvent(event)).toBe(false);
    old.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(useStore.getState().projects.some((project) => project.name === "Old bootstrap")).toBe(
      false,
    );
  },
);

it("an obsolete same-thread token cannot release or fail its successor's hydration", async () => {
  const fresh = createProjectGateApi();
  await runBoundedBootstrap({ api: fresh.api, selectedThreadId: recentId, disposed: () => false });
  const old = blockedApi();
  let disposed = false;
  const result = runBoundedBootstrap({
    api: old.api,
    selectedThreadId: recentId,
    disposed: () => disposed,
  });
  const rejected = expect(result).rejects.toThrow("superseded");
  threadHydrationEventBuffer.bufferEvent(
    makeEvent(
      "thread.meta-updated",
      { threadId: recentId, title: "Inherited live update", updatedAt: "2026-11-09T00:00:00.000Z" },
      { sequence: 30 },
    ),
  );
  disposed = true;
  useStore.getState().setThreadHydration(recentId, { status: "unloaded" });
  await hydrateSelectedThread({ api: fresh.api, threadId: recentId });
  old.release();
  await rejected;
  expect(useStore.getState().threadHydrationById[recentId]?.status).toBe("complete");
  expect(useStore.getState().threads.find((thread) => thread.id === recentId)?.title).toBe(
    "Inherited live update",
  );
});

it("deadline releases selected-thread hydration so Retry is possible", async () => {
  vi.useFakeTimers();
  const old = blockedApi();
  const result = runBoundedBootstrap({
    api: old.api,
    selectedThreadId: recentId,
    disposed: () => false,
    timeoutMs: 20,
  });
  const rejected = expect(result).rejects.toThrow("timed out");
  expect(useStore.getState().threadHydrationById[recentId]?.status).toBe("loading");
  await vi.advanceTimersByTimeAsync(21);
  await rejected;
  expect(useStore.getState().threadHydrationById[recentId]).toMatchObject({
    status: "failed",
    retry: { kind: "initial" },
  });
  const fresh = createProjectGateApi();
  await runBoundedBootstrap({ api: fresh.api, selectedThreadId: recentId, disposed: () => false });
  expect(useStore.getState().threadHydrationById[recentId]?.status).toBe("complete");
  old.release();
  await vi.advanceTimersByTimeAsync(0);
  expect(useStore.getState().threadHydrationById[recentId]?.status).toBe("complete");
  expect(useStore.getState().projects.find((project) => project.id === chatsId)?.name).toBe(
    chatsId,
  );
});
