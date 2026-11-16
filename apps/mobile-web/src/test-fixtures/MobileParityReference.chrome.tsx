import { ThreadId } from "@bigbud/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { ChatHeader } from "~/components/chat/common/ChatHeader";
import { ChatBanner } from "~/components/chat/common/ChatBanner";
import { SidebarProvider } from "~/components/ui/sidebar";
import { TooltipProvider } from "~/components/ui/tooltip";
import { MobileAppHeader } from "../components/shell/MobileAppHeader";
import { MobileConnectionNotice } from "../components/shell/MobileConnectionNotice";
import { initialMobileRecoveryState } from "../logic/mobileRecovery.types";

const noop = () => {};
const fixtureThread = ThreadId.makeUnsafe("parity-header-thread");
const fixtureError = "The connection could not be refreshed. Your draft is preserved.";

export function MobileFixtureRouter({
  children,
  threadId = fixtureThread,
}: {
  children: ReactNode;
  threadId?: string;
}) {
  const [router] = useState(() => {
    const root = createRootRoute();
    const route = createRoute({
      getParentRoute: () => root,
      path: "/mobile/thread/$threadId",
      component: () => children,
    });
    return createRouter({
      routeTree: root.addChildren([route]),
      history: createMemoryHistory({ initialEntries: [`/mobile/thread/${threadId}`] }),
    });
  });
  return <RouterProvider router={router} />;
}

/** Actual header and error presentation with no backend, cwd, or mutation callbacks. */
export function MobileParityChrome({
  client,
  surface,
}: {
  client: "desktop" | "mobile";
  surface: "header" | "error";
}) {
  if (surface === "error") {
    return client === "desktop" ? (
      <ChatBanner
        variant="error"
        title="Connection failed"
        description={fixtureError}
        dismissLabel="Dismiss error"
        onDismiss={noop}
      />
    ) : (
      <MobileConnectionNotice
        state={{ ...initialMobileRecoveryState("unavailable"), reason: fixtureError }}
        onRetry={noop}
      />
    );
  }
  return client === "desktop" ? (
    <TooltipProvider>
      <SidebarProvider open className="min-h-0">
        <header className="flex min-h-12 w-full items-center border-b px-3">
          <ChatHeader
            activeThreadId={fixtureThread}
            activeThreadTitle="Review the mobile implementation"
            activeProjectName="Fixture project"
            isProjectThread={false}
            openInCwd={null}
            activeProjectScripts={undefined}
            preferredScriptId={null}
            keybindings={[]}
            availableEditors={[]}
            sidebarToggleShortcutLabel={null}
            rightPanelToggleShortcutLabel={null}
            rightPanelOpen={false}
            planCardLabel="Plan"
            planCardOpen={false}
            terminalLayoutMode="chat-only"
            onOpenOrchestra={noop}
            onRunProjectScript={noop}
            onAddProjectScript={async () => {}}
            onUpdateProjectScript={async () => {}}
            onDeleteProjectScript={async () => {}}
            onTogglePlanCard={noop}
            onOpenTerminal={noop}
            onSelectTerminalLayout={noop}
            onToggleRightPanel={noop}
          />
        </header>
      </SidebarProvider>
    </TooltipProvider>
  ) : (
    <MobileFixtureRouter>
      <MobileAppHeader
        title="Review the mobile implementation"
        conversation
        onOpenNavigation={noop}
        onNew={noop}
      />
    </MobileFixtureRouter>
  );
}
