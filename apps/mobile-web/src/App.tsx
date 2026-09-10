import { isBuiltInChatsProject, ProjectId, ThreadId } from "@bigbud/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  useRouterState,
} from "@tanstack/react-router";
import { useMemo, useState, type Dispatch, type SetStateAction } from "react";

import { MobileAppFrame } from "./components/shell/MobileAppFrame";
import { MobileStartupSplash } from "./components/shell/MobileStartupSplash";
import { useMobileSnapshot } from "./hooks/useMobileSnapshot";
import { useTheme } from "./theme/useTheme";

import { getMobileDraftThread, makeMobileComposerDraftIdentity } from "./lib/mobileDraftThread";
import { redactMobileText } from "./lib/mobileRedaction";
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
import { useMobileNewThread } from "./hooks/useMobileNewThread";
import {
  clearMobileSession,
  isMobileSessionExpired,
  readMobileSession,
  type StoredMobileSession,
} from "./lib/mobileSession";

function AppFrameContent({
  session,
  setSession,
}: {
  readonly session: StoredMobileSession | null;
  readonly setSession: Dispatch<SetStateAction<StoredMobileSession | null>>;
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { recoveryState, restart, snapshotQuery, connectionError } = useMobileSnapshot(session);
  const { startNewChat, startNewThread } = useMobileNewThread();
  const threadId = extractMobileThreadId(pathname);
  const draftThread =
    threadId && session
      ? getMobileDraftThread(
          makeMobileComposerDraftIdentity({
            backendBaseUrl: session.backendBaseUrl,
            sessionId: session.sessionId,
            threadId,
          }),
        )
      : null;
  const header = resolveMobileHeaderState(pathname, snapshotQuery.data, draftThread);
  const isThreadView = pathname.startsWith("/mobile/thread/") && !pathname.endsWith("/diff");
  const showLaunchSplash =
    isMobileLaunchRoute(pathname) &&
    session !== null &&
    !snapshotQuery.data &&
    (recoveryState.freshness === "refreshing" ||
      (recoveryState.freshness === "unavailable" &&
        recoveryState.reason === null &&
        snapshotQuery.isPending));
  const showLaunchRecoveryError =
    isMobileLaunchRoute(pathname) && session !== null && !snapshotQuery.data && !showLaunchSplash;

  function startContextualNewThread() {
    const currentThread = threadId
      ? snapshotQuery.data?.threads.find((thread) => thread.id === threadId)
      : null;
    const projectId = draftThread?.projectId ?? currentThread?.projectId;
    if (projectId && !isBuiltInChatsProject(projectId)) {
      startNewThread(projectId);
      return;
    }
    startNewChat();
  }

  return (
    <>
      {showLaunchSplash ? (
        <MobileStartupSplash />
      ) : showLaunchRecoveryError ? (
        <div className="grid gap-3 px-4 py-8">
          <p className="text-sm font-medium text-foreground">Unable to connect</p>
          <p className="text-sm text-muted-foreground">
            {connectionError
              ? redactMobileText(connectionError)
              : "Retry or pair again if the session expired."}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              className="min-h-11 rounded-md border border-border px-3 text-sm"
              onClick={restart}
              type="button"
            >
              Retry
            </button>
            <button
              className="min-h-11 rounded-md bg-secondary px-3 text-sm"
              onClick={() => {
                clearMobileSession();
                setSession(null);
                window.location.assign("/mobile");
              }}
              type="button"
            >
              Clear session
            </button>
          </div>
        </div>
      ) : (
        <MobileAppFrame
          backTo={header.backTo}
          breadcrumb={header.breadcrumb}
          isThreadView={isThreadView}
          onNew={startContextualNewThread}
          recoveryState={recoveryState}
          session={session}
          setSession={setSession}
          showBack={header.showBack}
          showLogo={header.showLogo}
          title={header.title}
        >
          <Outlet />
        </MobileAppFrame>
      )}
    </>
  );
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
  const sessionContextValue = useMemo(() => ({ session, setSession }), [session, setSession]);

  return (
    <MobileSessionContext.Provider value={sessionContextValue}>
      <MobileRpcProvider>
        <AppFrameContent session={session} setSession={setSession} />
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
