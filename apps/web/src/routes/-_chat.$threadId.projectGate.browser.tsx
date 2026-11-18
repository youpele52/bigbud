import type { NativeApi } from "@bigbud/contracts/server/ipc.nativeApi.ts";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";
import { ChatThreadRouteView } from "./_chat.$threadId";
import { runBoundedBootstrap } from "./-__root.bounded-bootstrap";
import { useStore } from "../stores/main";
import { useComposerDraftStore } from "../stores/composer";
import { resetComposerDraftStore } from "../stores/composer/composer.store.test.utils";
import {
  createProjectGateApi,
  deferredProjectPage,
  emptyPage,
  otherId,
  otherProjectId,
  resetProjectGateStore,
} from "../components/chat/view/ThreadProjectGate.test-helpers";

const draftId = ThreadId.makeUnsafe("local-draft-project-gate");
const mocks = vi.hoisted(() => ({ api: undefined as NativeApi | undefined, navigate: vi.fn() }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (config: object) => ({
    ...config,
    useParams: ({ select }: { select: (params: { threadId: string }) => unknown }) =>
      select({ threadId: "local-draft-project-gate" }),
    useSearch: () => ({}),
  }),
  retainSearchParams: () => undefined,
  useNavigate: () => mocks.navigate,
}));
vi.mock("../rpc/nativeApi", () => ({ readNativeApi: () => mocks.api }));
vi.mock("../hooks/useOrganizationEngagement", () => ({ useOrganizationEngagement: () => {} }));
vi.mock("../hooks/usePageTitle", () => ({ usePageTitle: () => {} }));
vi.mock("./-_chat.$threadId.activation", () => ({ useCanonicalThreadRouteActivation: () => {} }));
vi.mock("../components/chat/view/ChatView", () => ({ default: () => <p>Draft composer</p> }));
vi.mock("../components/sidebar/SidebarProjectItem", () => ({ BigbudLogo: () => <svg /> }));
vi.mock("~/components/ui/sidebar", () => ({
  SidebarInset: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../stores/rightPanel/rightPanel.coordinator", () => ({
  registerDiffPanelCloseAction: () => () => {},
}));
vi.mock("../stores/rightPanel/rightPanelTabs.store", () => ({
  useRightPanelTabsStore: { getState: () => ({ closeTab: () => {}, ensureTabOpen: () => {} }) },
}));

beforeEach(() => {
  localStorage.clear();
  resetProjectGateStore();
  resetComposerDraftStore();
  mocks.navigate.mockClear();
});
afterEach(async () => {
  await cleanup();
  mocks.api = undefined;
});

it("recovers and retains a local draft's omitted project before exposing its composer", async () => {
  const { api, orchestration } = createProjectGateApi();
  Object.assign(api.orchestration, {
    resolveThreadOwnership: vi.fn(async () => ({
      threadId: draftId,
      status: "absent",
      serverEpoch: "server-1",
      canonicalRevision: 10,
      reusePolicy: "canonical-identity-unclaimed",
    })),
  });
  mocks.api = api;
  await runBoundedBootstrap({ api, selectedThreadId: otherId, disposed: () => false });
  const project = useStore.getState().projects.find((entry) => entry.id === otherProjectId)!;
  useStore.setState({ projects: [], projectDependencyOnlyIds: {} });
  useComposerDraftStore.getState().setDraftThreadContext(draftId, { projectId: otherProjectId });
  useComposerDraftStore.getState().setPrompt(draftId, "Keep this draft");
  const page = deferredProjectPage();
  orchestration.getStartupProjectCatalog.mockImplementation(() => page.promise);
  const screen = await render(<ChatThreadRouteView />);
  await expect.element(screen.getByRole("status")).toHaveTextContent("Loading chat project");
  await expect.element(screen.getByText("Draft composer")).not.toBeInTheDocument();
  expect(useStore.getState().projectDependencyRefCounts?.[otherProjectId]).toBe(1);
  expect(orchestration.getStartupProjectCatalog).toHaveBeenCalledWith(
    expect.objectContaining({
      priorityProjectId: otherProjectId,
      limit: 1,
    }),
  );
  // Use the actual server summary so recovery follows the production mapping path.
  const source = createProjectGateApi();
  const recovered = await source.orchestration.getStartupProjectCatalog({
    scope: "local",
    limit: 1,
    priorityProjectId: otherProjectId,
  });
  page.resolve(recovered);
  await expect.element(screen.getByText("Draft composer")).toBeInTheDocument();
  expect(useStore.getState().projects.find((entry) => entry.id === otherProjectId)?.cwd).toBe(
    project.cwd,
  );
  useStore
    .getState()
    .syncBoundedCatalog(
      { local: emptyPage },
      {},
      {},
      await orchestration.getSidebarThreadCatalog(),
      [],
    );
  expect(useStore.getState().projects.some((entry) => entry.id === otherProjectId)).toBe(true);
  expect(useComposerDraftStore.getState().draftsByThreadId[draftId]?.prompt).toBe(
    "Keep this draft",
  );
  expect(mocks.navigate).not.toHaveBeenCalled();
});
