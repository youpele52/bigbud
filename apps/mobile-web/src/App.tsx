import { ProjectId, ThreadId } from "@bigbud/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  useRouterState,
} from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { MobileAppHeader } from "./components/shell/MobileAppHeader";
import { MobileStartupSplash } from "./components/shell/MobileStartupSplash";
import { useMobileSnapshot } from "./hooks/useMobileSnapshot";
import { useTheme } from "./theme/useTheme";

import { getMobileDraftThread } from "./lib/mobileDraftThread";
import {
  extractMobileThreadId,
  isMobileLaunchRoute,
  resolveMobileHeaderState,
} from "./logic/mobileHeader.logic";
import { MobileRpcProvider } from "./context/MobileRpcContext";
import { MobileSessionContext } from "./context/MobileSessionContext";
import { MobileChats } from "./screens/MobileChats";
import { MobileDiff } from "./screens/MobileDiff";
import { MobileLaunch } from "./screens/MobileLaunch";
import { MobilePair } from "./screens/MobilePair";
import { MobileProjects } from "./screens/MobileProjects";
import { MobileProjectThreads } from "./screens/MobileProjectThreads";
import { MobileThread } from "./screens/MobileThread";
import { clearMobileSession, isMobileSessionExpired, readMobileSession } from "./lib/mobileSession";

function handleReconnect() {
  window.location.reload();
}

function AppFrame() {
  useTheme();
  const [session, setSession] = useState(() => {
    const current = readMobileSession();
    if (current && isMobileSessionExpired(current)) {
      clearMobileSession();
      return null;
    }
    return current;
  });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { snapshotQuery } = useMobileSnapshot(session);
  const threadId = extractMobileThreadId(pathname);
  const draftThread = threadId ? getMobileDraftThread(threadId) : null;
  const header = resolveMobileHeaderState(pathname, snapshotQuery.data, draftThread);
  const isThreadView = pathname.startsWith("/mobile/thread/") && !pathname.endsWith("/diff");
  const showLaunchSplash =
    isMobileLaunchRoute(pathname) && session !== null && snapshotQuery.isLoading;
  const sessionContextValue = useMemo(() => ({ session, setSession }), [session, setSession]);

  function handleSignOut() {
    setSession(null);
    window.location.assign("/mobile");
  }

  return (
    <MobileSessionContext.Provider value={sessionContextValue}>
      <MobileRpcProvider>
        {showLaunchSplash ? (
          <MobileStartupSplash />
        ) : (
          <div
            className={
              isThreadView
                ? "h-dvh overflow-hidden bg-background text-foreground"
                : "min-h-dvh bg-background text-foreground"
            }
          >
            <div
              className={
                isThreadView
                  ? "mx-auto flex h-dvh max-w-3xl flex-col overflow-hidden px-4 pt-2"
                  : "mx-auto flex min-h-dvh max-w-3xl flex-col px-4 pb-8 pt-2"
              }
            >
              <MobileAppHeader
                backTo={header.backTo}
                breadcrumb={header.breadcrumb}
                onReconnect={handleReconnect}
                onSignOut={handleSignOut}
                showBack={header.showBack}
                showLogo={header.showLogo}
                title={header.title}
              />
              <main className={isThreadView ? "min-h-0 flex-1 overflow-hidden" : "flex-1 px-3"}>
                <Outlet />
              </main>
            </div>
          </div>
        )}
      </MobileRpcProvider>
    </MobileSessionContext.Provider>
  );
}

const rootRoute = createRootRoute({
  component: AppFrame,
});

const mobileHomeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mobile",
  component: MobileLaunch,
});

const mobileHomeAliasRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: MobileLaunch,
});

const mobileProjectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mobile/projects",
  component: MobileProjects,
});

const mobileProjectThreadsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mobile/projects/$projectId",
  component: () => {
    const { projectId } = mobileProjectThreadsRoute.useParams();
    return <MobileProjectThreads projectId={ProjectId.makeUnsafe(projectId)} />;
  },
});

const mobileChatsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mobile/chats",
  component: MobileChats,
});

const mobilePairRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mobile/pair/$pairingId",
  component: () => {
    const { pairingId } = mobilePairRoute.useParams();
    return <MobilePair pairingId={pairingId} />;
  },
});

const mobileThreadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mobile/thread/$threadId",
  component: () => {
    const { threadId } = mobileThreadRoute.useParams();
    return <MobileThread threadId={ThreadId.makeUnsafe(threadId)} />;
  },
});

const mobileDiffRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mobile/thread/$threadId/diff",
  validateSearch: (search: Record<string, unknown>) => ({
    toTurnCount: Number(search.toTurnCount ?? 0),
  }),
  component: () => {
    const { threadId } = mobileDiffRoute.useParams();
    const { toTurnCount } = mobileDiffRoute.useSearch();
    return <MobileDiff threadId={ThreadId.makeUnsafe(threadId)} toTurnCount={toTurnCount} />;
  },
});

const routeTree = rootRoute.addChildren([
  mobileHomeAliasRoute,
  mobileHomeRoute,
  mobileProjectsRoute,
  mobileProjectThreadsRoute,
  mobileChatsRoute,
  mobilePairRoute,
  mobileThreadRoute,
  mobileDiffRoute,
]);

const queryClient = new QueryClient();
const router = createRouter({
  routeTree,
  Wrap: ({ children }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  ),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export function App() {
  const nextRouter = useMemo(() => router, []);
  return <RouterProvider router={nextRouter} />;
}
