import { isBuiltInChatsProject, ProjectId, ThreadId } from "@bigbud/contracts";
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useMemo, type Dispatch, type SetStateAction } from "react";

import { isMobileStartupWaiting } from "./components/shell/MobileSessionGate.logic";
import { MobileAppFrame } from "./components/shell/MobileAppFrame";
import { MobileStartupSplash } from "./components/shell/MobileStartupSplash";
import {
  MobileConnectingStatus,
  MobileSessionConnectionDetails,
} from "./components/shell/MobileConnectingStatus";
import { useMobileSnapshot } from "./hooks/useMobileSnapshot";

import {
  clearMobileDraftThreads,
  getMobileDraftThread,
  makeMobileComposerDraftIdentity,
} from "./lib/mobileDraftThread";
import { redactMobileText } from "./lib/mobileRedaction";
import {
  extractMobileThreadId,
  isMobileLaunchRoute,
  resolveMobileHeaderState,
} from "./logic/mobileHeader.logic";
import { MobileSessionRuntime } from "./context/MobileSessionRuntime";
import { writeMobileSelectedThread } from "./lib/mobileHostSelection";
import { getMobileSessionAuthority } from "./lib/mobileSessionAuthority";
import { useMobileHosts } from "./context/MobileHostsContext";
import { MobileChats } from "./screens/MobileChats";
import { MobileDiff } from "./screens/MobileDiff";
import { MobileLaunch } from "./screens/MobileLaunch";
import { MobilePair } from "./screens/MobilePair";
import { MobileProjects } from "./screens/MobileProjects";
import { MobileProjectThreads } from "./screens/MobileProjectThreads";
import { MobileThread } from "./screens/MobileThread";
import { MobileThreadProviderIcon } from "./components/threads/MobileThreadProviderIcon";
import { useMobileNewThread } from "./hooks/useMobileNewThread";
import { useMobileViewport } from "./hooks/useMobileViewport";
import { clearMobileSession, type StoredMobileSession } from "./lib/mobileSession";

function AppFrameContent({
  session,
  setSession,
}: {
  readonly session: StoredMobileSession | null;
  readonly setSession: Dispatch<SetStateAction<StoredMobileSession | null>>;
}) {
  const hostContext = useMobileHosts();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { connection, recovery, recoveryState, restart, snapshotQuery, connectionError } =
    useMobileSnapshot(session);
  const { startNewChat, startNewThread } = useMobileNewThread();
  const threadId = extractMobileThreadId(pathname);
  // A real route deselection changes recovery scope. Client replacement cleanup must not.
  useEffect(() => {
    if (!threadId && recovery?.getState().selectedThreadId) {
      void recovery.selectThread(null).catch(() => undefined);
    }
  }, [threadId, recovery]);
  const draftThread =
    threadId && session
      ? getMobileDraftThread(
          makeMobileComposerDraftIdentity({
            backendBaseUrl: session.backendBaseUrl,
            sessionId: session.sessionId,
            authorityId: getMobileSessionAuthority(session),
            threadId,
          }),
        )
      : null;
  const header = resolveMobileHeaderState(pathname, snapshotQuery.data, draftThread);
  const isThreadView = pathname.startsWith("/mobile/thread/") && !pathname.endsWith("/diff");
  const conversationThread = threadId
    ? (snapshotQuery.data?.threads.find((candidate) => candidate.id === threadId) ?? null)
    : null;
  const ownsSelectedThread = !!(conversationThread || draftThread);
  const reportHostIssue = hostContext?.hosts.reportIssue;
  useLayoutEffect(() => {
    if (!session || !getMobileSessionAuthority(session) || !threadId || !ownsSelectedThread) return;
    if (!writeMobileSelectedThread(session, ThreadId.makeUnsafe(threadId)))
      reportHostIssue?.(
        "This thread could not be remembered. Your draft and current connection are preserved.",
      );
  }, [session, threadId, ownsSelectedThread, reportHostIssue]);
  const showLaunchSplash =
    isMobileLaunchRoute(pathname) &&
    session !== null &&
    !snapshotQuery.data &&
    isMobileStartupWaiting(connection, recoveryState, snapshotQuery.isPending);
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
        <MobileStartupSplash>
          {session ? <MobileConnectingStatus session={session} /> : null}
        </MobileStartupSplash>
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
                if (hostContext && !hostContext.forgetSelected()) return;
                if (session && !hostContext?.hosts.selected) {
                  clearMobileDraftThreads({
                    backendBaseUrl: session.backendBaseUrl,
                    sessionId: session.sessionId,
                    authorityId: getMobileSessionAuthority(session),
                  });
                }
                if (!hostContext) clearMobileSession();
                setSession(null);
                window.location.assign("/mobile");
              }}
              type="button"
            >
              Clear session
            </button>
          </div>
          {session ? <MobileSessionConnectionDetails session={session} /> : null}
        </div>
      ) : (
        <MobileAppFrame
          backTo={header.backTo}
          breadcrumb={header.breadcrumb}
          conversationProviderIcon={
            isThreadView && conversationThread ? (
              <MobileThreadProviderIcon thread={conversationThread} />
            ) : undefined
          }
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
  return (
    <MobileSessionRuntime>
      {(session, setSession) => <AppFrameContent session={session} setSession={setSession} />}
    </MobileSessionRuntime>
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
    return <MobileThread key={threadId} threadId={ThreadId.makeUnsafe(threadId)} />;
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

const router = createRouter({
  routeTree,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export function App() {
  useMobileViewport();
  const nextRouter = useMemo(() => router, []);
  return <RouterProvider router={nextRouter} />;
}
