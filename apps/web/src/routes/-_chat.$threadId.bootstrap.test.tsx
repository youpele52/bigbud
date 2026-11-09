import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  threadId: "synthetic-restored",
  navigate: vi.fn(),
  effects: [] as Array<{ run: () => void | (() => void); deps: readonly unknown[] }>,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (run: () => void | (() => void), deps: readonly unknown[]) => {
    harness.effects.push({ run, deps });
  },
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: object) => ({
    ...config,
    useParams: ({ select }: { select: (params: { threadId: string }) => unknown }) =>
      select({ threadId: harness.threadId }),
    useSearch: () => ({}),
  }),
  retainSearchParams: () => undefined,
  useNavigate: () => harness.navigate,
}));
vi.mock("../stores/main", async (original) => {
  const actual = await original<typeof import("../stores/main")>();
  return {
    ...actual,
    useStore: Object.assign(
      (selector: (state: ReturnType<typeof actual.useStore.getState>) => unknown) =>
        selector(actual.useStore.getState()),
      actual.useStore,
    ),
  };
});
vi.mock("../rpc/nativeApi", () => ({ readNativeApi: () => fixture.api }));
vi.mock("../hooks/useOrganizationEngagement.ts", () => ({ useOrganizationEngagement: vi.fn() }));
vi.mock("../hooks/usePageTitle", () => ({ usePageTitle: vi.fn() }));
vi.mock("./-_chat.$threadId.activation", () => ({ useCanonicalThreadRouteActivation: vi.fn() }));
vi.mock("../components/chat/view/ChatView", () => ({ default: () => null }));
vi.mock("../components/chat/view/ThreadProjectGate", () => ({
  ThreadProjectGate: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../components/sidebar/SidebarProjectItem", () => ({ BigbudLogo: () => null }));
vi.mock("~/components/ui/sidebar", () => ({
  SidebarInset: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../stores/rightPanel/rightPanel.coordinator", () => ({
  registerDiffPanelCloseAction: () => () => undefined,
}));

import { ChatThreadRouteView } from "./_chat.$threadId";
import { useStore } from "../stores/main";
import { threadHydrationEventBuffer } from "../logic/orchestration/thread-hydration-events.logic";
import {
  createProjectGateApi,
  resetProjectGateStore,
  otherId,
  recentId,
} from "../components/chat/view/ThreadProjectGate.test-helpers";

let fixture = createProjectGateApi();
let effects: Array<{ deps: readonly unknown[]; cleanup: void | (() => void) }> = [];
// Commit route effects across SSR renders to exercise the exact dependency/cleanup lifecycle
// without a DOM or loading the real chat tree.
function renderRoute() {
  harness.effects = [];
  renderToStaticMarkup(<ChatThreadRouteView />);
  effects = harness.effects.map(({ run, deps }, index) => {
    const previous = effects[index];
    if (previous && deps.every((dep, i) => Object.is(dep, previous.deps[i]))) return previous;
    previous?.cleanup?.();
    return { deps, cleanup: run() };
  });
}

beforeEach(() => {
  resetProjectGateStore();
  fixture = createProjectGateApi();
  harness.threadId = otherId;
  harness.navigate.mockClear();
  useStore.setState({ bootstrapComplete: true });
});
afterEach(() => {
  for (const effect of effects) effect.cleanup?.();
  effects = [];
  threadHydrationEventBuffer.clear();
});

it("keeps a deep-link bootstrap alive across its own loading render", async () => {
  const detail = await fixture.orchestration.getSelectedThreadDetail({ threadId: otherId });
  let release!: (value: typeof detail) => void;
  fixture.orchestration.getSelectedThreadDetail.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  renderRoute();
  expect(useStore.getState().threadHydrationById[otherId]?.status).toBe("loading");
  renderRoute();
  release(detail);
  await vi.waitFor(() => {
    expect(useStore.getState().threadHydrationById[otherId]?.status).toBe("complete");
  });
  renderRoute();
  expect(harness.navigate).not.toHaveBeenCalled();
});

it("keeps the route read alive if another catalog supplies its summary while detail is pending", async () => {
  const detail = await fixture.orchestration.getSelectedThreadDetail({ threadId: otherId });
  let release!: (value: typeof detail) => void;
  fixture.orchestration.getSelectedThreadDetail.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  renderRoute();
  useStore.getState().syncSidebarCatalog(await fixture.orchestration.getSidebarThreadCatalog());
  renderRoute();
  release(detail);
  await vi.waitFor(() => {
    expect(useStore.getState().threadHydrationById[otherId]?.status).toBe("complete");
  });
  expect(harness.navigate).not.toHaveBeenCalled();
});

it("still disposes the old bootstrap when navigation changes the thread intent", async () => {
  const detail = await fixture.orchestration.getSelectedThreadDetail({ threadId: otherId });
  let release!: (value: typeof detail) => void;
  fixture.orchestration.getSelectedThreadDetail.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  renderRoute();
  harness.threadId = recentId;
  renderRoute();
  release(detail);
  await vi.waitFor(() => {
    expect(useStore.getState().threadHydrationById[otherId]?.status).toBe("failed");
    expect(useStore.getState().threadHydrationById[recentId]?.status).toBe("complete");
  });
  expect(harness.navigate).not.toHaveBeenCalled();
});
