import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { DEFAULT_THREAD_TITLE } from "@bigbud/shared/String";

import type { MobileHeaderBreadcrumbSegment } from "../../logic/mobileHeader.logic";
import type { MobileRecoveryState } from "../../logic/mobileRecovery.types";
import { clearMobileDraftThreads } from "../../lib/mobileDraftThread";
import { useMobileHosts } from "../../context/MobileHostsContext";
import {
  getMobileSessionAuthority,
  mobileSessionStateScope,
} from "../../lib/mobileSessionAuthority";
import { MobileHostSwitcher } from "./MobileHostSwitcher";
import { clearMobileSession, type StoredMobileSession } from "../../lib/mobileSession";
import { useMobileRpcClient } from "../../context/MobileRpcContext";
import { MobileNavigationSheet } from "./MobileNavigationSheet";
import { MobileAppHeader } from "./MobileAppHeader";
import {
  parseMobileNavigationView,
  areMobileNavigationViewsEqual,
  withoutMobileNavigationView,
  withMobileNavigationView,
  type MobileNavigationView,
} from "./MobileNavigationSheet.logic";

interface MobileAppFrameProps {
  readonly children: ReactNode;
  readonly session: StoredMobileSession | null;
  readonly setSession: (session: StoredMobileSession | null) => void;
  readonly title?: string | undefined;
  readonly breadcrumb?: ReadonlyArray<MobileHeaderBreadcrumbSegment> | undefined;
  readonly conversationProviderIcon?: ReactNode | undefined;
  readonly showLogo?: boolean | undefined;
  readonly showBack?: boolean | undefined;
  readonly backTo?: string | undefined;
  readonly isThreadView: boolean;
  readonly recoveryState: MobileRecoveryState;
  readonly onNew: () => void;
}

export function MobileAppFrame({
  children,
  session,
  setSession,
  title,
  breadcrumb,
  conversationProviderIcon,
  showLogo,
  showBack,
  backTo,
  isThreadView,
  recoveryState,
  onNew,
}: MobileAppFrameProps) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const historyState = useRouterState({ select: (state) => state.location.state });
  const hostContext = useMobileHosts();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { client, connection, recovery, restart } = useMobileRpcClient();
  const view = parseMobileNavigationView(historyState);
  const isPairing = pathname.includes("/pair");
  const [retainedView, setRetainedView] = useState<MobileNavigationView | null>(() => view);
  const navigationView = view ?? retainedView;
  const navigationOpen = view !== null;

  useEffect(() => {
    if (!session || isPairing) {
      if (retainedView !== null) {
        setRetainedView(null);
      }
      return;
    }
    if (view && !areMobileNavigationViewsEqual(view, retainedView)) {
      setRetainedView(view);
    }
  }, [isPairing, retainedView, session, view]);

  function updateView(nextView: MobileNavigationView | null, replace: boolean) {
    void navigate({
      to: pathname,
      replace,
      state: (previous) =>
        nextView
          ? withMobileNavigationView(previous, nextView)
          : withoutMobileNavigationView(previous),
    });
  }

  function forgetConnection() {
    if (hostContext && !hostContext.forgetSelected()) return;
    const sessionId = session ? mobileSessionStateScope(session, "query") : undefined;
    setRetainedView(null);
    recovery?.dispose();
    void client?.dispose();
    if (sessionId) {
      queryClient.removeQueries({ queryKey: ["mobile-snapshot", sessionId] });
      queryClient.removeQueries({ queryKey: ["mobile-thread", sessionId] });
      queryClient.removeQueries({ queryKey: ["mobile-diff", sessionId] });
    }
    if (session && !hostContext?.hosts.selected) {
      clearMobileDraftThreads({
        backendBaseUrl: session.backendBaseUrl,
        sessionId: session.sessionId,
        authorityId: getMobileSessionAuthority(session),
      });
    }
    if (!hostContext) clearMobileSession();
    setSession(null);
    void navigate({ to: "/mobile", replace: true, state: {} });
  }

  const conversationTitle = breadcrumb?.at(-1)?.label ?? title ?? DEFAULT_THREAD_TITLE;

  return (
    <div
      className={
        isThreadView
          ? "mobile-shell h-dvh min-h-0 min-w-0 overflow-hidden bg-background text-foreground"
          : "mobile-shell max-h-dvh min-h-dvh overflow-y-auto bg-background text-foreground"
      }
    >
      <div
        className={
          isThreadView
            ? "mx-auto flex h-full min-h-0 min-w-0 w-full max-w-3xl flex-col overflow-hidden px-4 pt-2"
            : "mx-auto flex min-h-full max-w-3xl flex-col px-4 pb-8 pt-2"
        }
      >
        {!isPairing ? (
          <MobileAppHeader
            backTo={backTo}
            breadcrumb={breadcrumb}
            connectionState={recoveryState}
            connection={connection}
            conversation={isThreadView}
            conversationProviderIcon={conversationProviderIcon}
            onNew={onNew}
            onOpenNavigation={() => updateView({ kind: "chats" }, false)}
            navigationOpen={navigationOpen}
            showBack={showBack}
            showLogo={showLogo}
            title={conversationTitle}
            trailing={<MobileHostSwitcher />}
          />
        ) : null}
        {hostContext?.hosts.error ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-destructive" role="alert">
            <span>{hostContext.hosts.error}</span>
            <button
              className="min-h-11 rounded-md px-2 text-sm underline"
              onClick={hostContext.hosts.retryStorage}
              type="button"
            >
              Reload saved hosts
            </button>
          </div>
        ) : null}
        <main className={isThreadView ? "min-h-0 min-w-0 flex-1 overflow-hidden" : "flex-1 px-3"}>
          {children}
        </main>
      </div>
      {!isPairing && session && navigationView ? (
        <MobileNavigationSheet
          onClose={() => {
            if (view) {
              updateView(null, true);
            }
          }}
          onOpenChangeComplete={(open) => {
            if (!open && view === null) {
              setRetainedView(null);
            }
          }}
          onForget={forgetConnection}
          onRetry={restart}
          onViewChange={(nextView) => updateView(nextView, true)}
          open={navigationOpen}
          recoveryState={recoveryState}
          connection={connection}
          session={session}
          view={navigationView}
        />
      ) : null}
    </div>
  );
}
