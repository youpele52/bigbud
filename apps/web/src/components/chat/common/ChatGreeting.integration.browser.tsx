import "../../../index.css";

import { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({ random: vi.fn(() => 0.5) }));
vi.mock("../../../utils/copy/greeting.logic", async (original) => {
  const actual = await original<typeof import("../../../utils/copy/greeting.logic")>();
  return { ...actual, greetingForChat: actual.createGreetingSelector({ random: mocks.random }) };
});

import { AppAtomRegistryProvider } from "../../../rpc/atomRegistry";
import {
  resetServerStateForTests,
  setServerConfigSnapshot,
  startServerStateSync,
} from "../../../rpc/serverState";
import { useStore } from "../../../stores/main/main.store";
import { useComposerDraftStore } from "../../../stores/composer";
import { resetComposerDraftStore } from "../../../stores/composer/composer.store.test.utils";
import { ChatGreetingIntegrationHarness } from "./ChatGreeting.integration.harness";
import { createGreetingServerConfig } from "./ChatGreeting.integration.fixture";

const projectId = ProjectId.makeUnsafe("greeting-integration-project");

function createDraftRouter(threadId: ThreadId) {
  const root = createRootRoute();
  const chat = createRoute({
    getParentRoute: () => root,
    path: "/$threadId",
    component: ChatGreetingIntegrationHarness,
  });
  return createRouter({
    routeTree: root.addChildren([chat]),
    history: createMemoryHistory({ initialEntries: [`/${threadId}`] }),
  });
}

describe("production fresh-chat greeting integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    resetServerStateForTests();
    resetComposerDraftStore();
    useStore.setState({
      ...useStore.getInitialState(),
      bootstrapComplete: true,
      projects: [
        {
          id: projectId,
          name: "Greeting project",
          cwd: "/greeting-test",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-10-11T09:00:00.000Z",
          updatedAt: "2026-10-11T09:00:00.000Z",
        },
      ],
    });
    setServerConfigSnapshot(createGreetingServerConfig());
  });

  afterEach(() => {
    document.body.innerHTML = "";
    resetComposerDraftStore();
    resetServerStateForTests();
    useStore.setState(useStore.getInitialState());
  });

  it("shows greetings for consecutive real local drafts through the production timeline", async () => {
    const firstId = ThreadId.makeUnsafe("integration-draft-first");
    const secondId = ThreadId.makeUnsafe("integration-draft-second");
    const drafts = useComposerDraftStore.getState();
    drafts.setProjectDraftThreadId(projectId, firstId);
    const router = createDraftRouter(firstId);
    const screen = await render(
      <AppAtomRegistryProvider>
        <RouterProvider router={router} />
      </AppAtomRegistryProvider>,
    );
    try {
      await vi.waitFor(() =>
        expect(document.querySelector("[data-local-draft]")?.getAttribute("data-local-draft")).toBe(
          "true",
        ),
      );
      expect(document.querySelector("[data-working]")?.getAttribute("data-working")).toBe("false");
      expect(document.querySelector("[data-entry-count]")?.getAttribute("data-entry-count")).toBe(
        "0",
      );
      await vi.waitFor(() => expect(document.querySelector("p")?.textContent).toContain("Youpele"));
      drafts.setProjectDraftThreadId(projectId, secondId);
      await router.navigate({ to: "/$threadId", params: { threadId: secondId } });
      await vi.waitFor(() => expect(document.querySelector("p")?.textContent).toContain("Youpele"));
      expect(mocks.random).toHaveBeenCalledTimes(6);
    } finally {
      await screen.unmount();
    }
  });

  it("waits for real bootstrap and server config state, then shows the greeting without changing draft identity", async () => {
    resetServerStateForTests();
    useStore.setState({ bootstrapComplete: false });
    const threadId = ThreadId.makeUnsafe("integration-delayed-startup");
    useComposerDraftStore.getState().setProjectDraftThreadId(projectId, threadId);
    let resolve!: (config: ReturnType<typeof createGreetingServerConfig>) => void;
    const config = new Promise<ReturnType<typeof createGreetingServerConfig>>((done) => {
      resolve = done;
    });
    const stopSync = startServerStateSync({
      getConfig: () => config,
      subscribeConfig: () => () => {},
      subscribeLifecycle: () => () => {},
    });
    const screen = await render(
      <AppAtomRegistryProvider>
        <RouterProvider router={createDraftRouter(threadId)} />
      </AppAtomRegistryProvider>,
    );
    try {
      await vi.waitFor(() => expect(document.querySelector("svg")).not.toBeNull());
      expect(document.querySelector("p")).toBeNull();
      expect(mocks.random).not.toHaveBeenCalled();
      useStore.setState({ bootstrapComplete: true });
      expect(document.querySelector("p")).toBeNull();
      resolve(createGreetingServerConfig());
      await vi.waitFor(() => expect(document.querySelector("p")?.textContent).toContain("Youpele"));
      expect(mocks.random).toHaveBeenCalledTimes(3);
    } finally {
      stopSync();
      await screen.unmount();
    }
  });
});
