import type { NativeApi } from "@bigbud/contracts/server/ipc.nativeApi.ts";
import { ProjectId } from "@bigbud/contracts/core/baseSchemas";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import { loadProjectById } from "../../../lib/projectCatalog";
import { useProjectReadiness } from "../../../hooks/useProjectReadiness";
import {
  hydrateSelectedThread,
  runBoundedBootstrap,
} from "../../../routes/-__root.bounded-bootstrap";
import { useComposerDraftStore } from "../../../stores/composer/composer.store";
import { resetComposerDraftStore } from "../../../stores/composer/composer.store.test.utils";
import { useStore } from "../../../stores/main";
import { ThreadProjectGate } from "./ThreadProjectGate";
import {
  chatsId,
  chatsPage,
  createProjectGateApi,
  deferredProjectPage,
  emptyPage,
  otherId,
  prepareRecentPrompt,
  recentId,
  resetProjectGateStore,
} from "./ThreadProjectGate.test-helpers";

const mocks = vi.hoisted(() => ({
  api: undefined as NativeApi | undefined,
  mount: vi.fn(),
  unmount: vi.fn(),
}));
vi.mock("../../../rpc/nativeApi", () => ({ readNativeApi: () => mocks.api }));
vi.mock("../../sidebar/SidebarProjectItem", () => ({ BigbudLogo: () => <svg /> }));
vi.mock("../../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

function Composer() {
  const [prompt, setPrompt] = useState(
    () => useComposerDraftStore.getState().draftsByThreadId[recentId]?.prompt ?? "",
  );
  const [sent, setSent] = useState("");
  useEffect(() => {
    mocks.mount();
    return () => {
      mocks.unmount();
    };
  }, []);
  return (
    <>
      <textarea
        aria-label="Prompt"
        value={prompt}
        onChange={(event) => {
          setPrompt(event.target.value);
          useComposerDraftStore.getState().setPrompt(recentId, event.target.value);
        }}
      />
      <button
        onClick={() => {
          void prepareRecentPrompt(mocks.api!, prompt).then(({ result }) => {
            if (result) setSent(result.outgoingMessageText);
          });
        }}
      >
        Send
      </button>
      <p data-testid="prepared-prompt">{sent}</p>
    </>
  );
}

beforeEach(() => {
  resetProjectGateStore();
  resetComposerDraftStore();
  mocks.mount.mockClear();
  mocks.unmount.mockClear();
  mocks.api = undefined;
  useComposerDraftStore.getState().setPrompt(recentId, "Synthetic follow-up");
});
afterEach(async () => {
  await cleanup();
});

it("resolves an omitted Recent project after bootstrap elsewhere, coalescing concurrent consumers", async () => {
  const { api, orchestration } = createProjectGateApi();
  mocks.api = api;
  await runBoundedBootstrap({ api, selectedThreadId: otherId, disposed: () => false });
  expect(useStore.getState().sidebarRecentThreadIds).toContain(recentId);
  await hydrateSelectedThread({ api, threadId: recentId });
  expect(useStore.getState().threadHydrationById[recentId]?.status).toBe("complete");
  expect(useStore.getState().projects.some((project) => project.id === chatsId)).toBe(false);
  const pagination = useStore.getState().projectCatalogCursorByScope;
  orchestration.getStartupProjectCatalog.mockClear();
  const pending = deferredProjectPage();
  orchestration.getStartupProjectCatalog.mockImplementation(() => pending.promise);

  const screen = await render(
    <ThreadProjectGate projectId={chatsId}>
      <Composer />
    </ThreadProjectGate>,
  );
  await expect.element(screen.getByRole("status")).toHaveTextContent("Loading chat project");
  await expect
    .element(screen.getByRole("button", { name: "Send", exact: true }))
    .not.toBeInTheDocument();
  expect(mocks.mount).not.toHaveBeenCalled();
  const concurrent = loadProjectById({
    api,
    projectId: chatsId,
    getProject: () => useStore.getState().projects.find((project) => project.id === chatsId),
    mergeProjectCatalogPage: useStore.getState().mergeProjectCatalogPage,
  });
  expect(orchestration.getStartupProjectCatalog.mock.calls).toEqual([
    [{ scope: "local", limit: 1, priorityProjectId: chatsId }],
    [{ scope: "remote", limit: 1, priorityProjectId: chatsId }],
  ]);
  pending.resolve(chatsPage);
  await concurrent;
  await expect
    .element(screen.getByRole("textbox", { name: "Prompt" }))
    .toHaveValue("Synthetic follow-up");
  await screen.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .element(screen.getByTestId("prepared-prompt"))
    .toHaveTextContent("Synthetic follow-up");
  expect(useStore.getState().projectCatalogCursorByScope).toEqual(pagination);
  expect(
    useStore.getState().threads.find((thread) => thread.id === recentId)?.session
      ?.orchestrationStatus,
  ).toBe("stopped");
});

function RestoringProject({ enabled }: { enabled: boolean }) {
  const { project, error } = useProjectReadiness(chatsId, enabled);
  return <p role="status">{project ? "Project ready" : (error ?? "Restoring thread")}</p>;
}

it("defers project resolution during compact-chat restoration and shares its pending load with a route", async () => {
  const { api, orchestration } = createProjectGateApi();
  mocks.api = api;
  const pending = deferredProjectPage();
  orchestration.getStartupProjectCatalog.mockImplementation(() => pending.promise);
  const screen = await render(<RestoringProject enabled={false} />);
  expect(orchestration.getStartupProjectCatalog).not.toHaveBeenCalled();
  await screen.rerender(<RestoringProject enabled />);
  expect(orchestration.getStartupProjectCatalog).toHaveBeenCalledTimes(2);
  await screen.rerender(
    <ThreadProjectGate projectId={chatsId}>
      <p>Route ready</p>
    </ThreadProjectGate>,
  );
  expect(orchestration.getStartupProjectCatalog).toHaveBeenCalledTimes(2);
  pending.resolve(chatsPage);
  await expect.element(screen.getByText("Route ready")).toBeVisible();
});

it("does not fetch an already loaded owning project", async () => {
  const { api, orchestration } = createProjectGateApi();
  mocks.api = api;
  await runBoundedBootstrap({ api, selectedThreadId: recentId, disposed: () => false });
  orchestration.getStartupProjectCatalog.mockClear();
  const screen = await render(
    <ThreadProjectGate projectId={chatsId}>
      <Composer />
    </ThreadProjectGate>,
  );
  await expect.element(screen.getByRole("textbox")).toHaveValue("Synthetic follow-up");
  expect(orchestration.getStartupProjectCatalog).not.toHaveBeenCalled();
});

it("re-ensures a project evicted by bounded recovery without unmounting or clearing the composer, even on failure", async () => {
  const { api, orchestration } = createProjectGateApi();
  mocks.api = api;
  await runBoundedBootstrap({ api, selectedThreadId: recentId, disposed: () => false });
  const screen = await render(
    <ThreadProjectGate projectId={chatsId}>
      <Composer />
    </ThreadProjectGate>,
  );
  await screen.getByRole("textbox").fill("Keep this unsent edit");
  const pending = deferredProjectPage();
  const original = orchestration.getStartupProjectCatalog.getMockImplementation()!;
  orchestration.getStartupProjectCatalog.mockImplementation((input) =>
    input.priorityProjectId === chatsId && input.limit === 1 ? pending.promise : original(input),
  );
  await runBoundedBootstrap({ api, selectedThreadId: otherId, disposed: () => false });
  // Mounted dependencies survive bounded replacement. Explicit entity loss still
  // exercises the gate's recover-in-place behavior without unmounting the editor.
  expect(useStore.getState().projects.some((project) => project.id === chatsId)).toBe(true);
  useStore.setState((state) => ({
    projects: state.projects.filter((project) => project.id !== chatsId),
  }));
  await expect.element(screen.getByRole("status")).toHaveTextContent("Loading chat project");
  expect(useStore.getState().projects.some((project) => project.id === chatsId)).toBe(false);
  expect(useComposerDraftStore.getState().draftsByThreadId[recentId]?.prompt).toBe(
    "Keep this unsent edit",
  );
  expect(mocks.unmount).not.toHaveBeenCalled();
  pending.reject(new Error("Project lookup failed"));
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Project lookup failed");
  orchestration.getStartupProjectCatalog.mockImplementation(original);
  await screen.getByRole("button", { name: "Retry loading project" }).click();
  await expect.element(screen.getByRole("textbox")).toHaveValue("Keep this unsent edit");
  expect(mocks.mount).toHaveBeenCalledTimes(1);
  expect(mocks.unmount).not.toHaveBeenCalled();
});

it("reports an unavailable project without retry loops, then permits an explicit retry", async () => {
  const { api, orchestration } = createProjectGateApi();
  mocks.api = api;
  orchestration.getStartupProjectCatalog.mockResolvedValue(emptyPage);
  const content = (
    <ThreadProjectGate projectId={chatsId}>
      <Composer />
    </ThreadProjectGate>
  );
  const screen = await render(content);
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("The selected project is unavailable.");
  await screen.rerender(content);
  expect(orchestration.getStartupProjectCatalog).toHaveBeenCalledTimes(2);
  expect(useStore.getState().projects).toEqual([]);
  expect(useComposerDraftStore.getState().draftsByThreadId[recentId]?.prompt).toBe(
    "Synthetic follow-up",
  );
  orchestration.getStartupProjectCatalog.mockResolvedValue(chatsPage);
  await screen.getByRole("button", { name: "Retry loading project" }).click();
  await expect.element(screen.getByRole("textbox")).toHaveValue("Synthetic follow-up");
  expect(orchestration.getStartupProjectCatalog).toHaveBeenCalledTimes(4);
});

it("offers retry when disconnected and loads after reconnect", async () => {
  const screen = await render(
    <ThreadProjectGate projectId={chatsId}>
      <Composer />
    </ThreadProjectGate>,
  );
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("bigbud is not connected to the server.");
  mocks.api = createProjectGateApi().api;
  await screen.getByRole("button", { name: "Retry loading project" }).click();
  await expect.element(screen.getByRole("textbox")).toHaveValue("Synthetic follow-up");
});

it.each(["success", "failure"] as const)(
  "ignores a late %s from the previous project after route navigation",
  async (outcome) => {
    const { api, orchestration } = createProjectGateApi();
    mocks.api = api;
    const first = deferredProjectPage();
    const second = deferredProjectPage();
    const nextId = ProjectId.makeUnsafe("next-project");
    orchestration.getStartupProjectCatalog.mockImplementation(({ priorityProjectId }) =>
      priorityProjectId === chatsId ? first.promise : second.promise,
    );
    const screen = await render(
      <ThreadProjectGate projectId={chatsId}>
        <p>First chat</p>
      </ThreadProjectGate>,
    );
    await screen.rerender(
      <ThreadProjectGate projectId={nextId}>
        <p>Next chat</p>
      </ThreadProjectGate>,
    );
    if (outcome === "failure") first.reject(new Error("Stale project error"));
    else first.resolve(chatsPage);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect.element(screen.getByRole("status")).toHaveTextContent("Loading chat project");
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
    await expect.element(screen.getByText("Next chat", { exact: true })).not.toBeInTheDocument();
    second.resolve({ ...chatsPage, projects: [{ ...chatsPage.projects[0]!, id: nextId }] });
    await expect.element(screen.getByText("Next chat", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("First chat", { exact: true })).not.toBeInTheDocument();
    expect(orchestration.getStartupProjectCatalog).toHaveBeenCalledTimes(4);
  },
);
