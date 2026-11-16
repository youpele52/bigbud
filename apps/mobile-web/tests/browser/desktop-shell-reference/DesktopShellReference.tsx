import type { AppRouter } from "~/config/router/router.config";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { CompactChatShell } from "~/components/floating-assistant/FloatingAssistantShell";
import { TooltipProvider } from "~/components/ui/tooltip";
import { AppAtomRegistryProvider, appAtomRegistry } from "~/rpc/atomRegistry";
import {
  getServerConfig,
  providersUpdatedAtom,
  serverConfigAtom,
  serverConfigUpdatedAtom,
  setServerConfigSnapshot,
} from "~/rpc/serverState";
import { useComposerDraftStore } from "~/stores/composer";
import { useStore } from "~/stores/main";
import {
  parityShellProjectId,
  parityShellPrompt,
  parityShellThreadId,
  parityShellTime,
} from "../../../src/test-fixtures/MobileParityReference.shell.data";
import { parityCompactChat, parityShellServerConfig } from "./DesktopShellReference.data";

function DesktopReadyShell() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const previousStore = useStore.getState();
    const previousDrafts = useComposerDraftStore.getState();
    const previousConfig = getServerConfig();
    const previousProviders = appAtomRegistry.get(providersUpdatedAtom);
    const previousUpdated = appAtomRegistry.get(serverConfigUpdatedAtom);
    useStore.setState({
      bootstrapComplete: true,
      projects: [
        {
          id: parityShellProjectId,
          name: "Fixture project",
          cwd: null,
          defaultModelSelection: { provider: "codex", model: "gpt-5.4" },
          scripts: [],
        },
      ],
      threads: [],
    });
    useComposerDraftStore
      .getState()
      .setProjectDraftThreadId(parityShellProjectId, parityShellThreadId, {
        createdAt: parityShellTime,
        runtimeMode: "approval-required",
        interactionMode: "default",
        envMode: "local",
      });
    useComposerDraftStore.getState().setPrompt(parityShellThreadId, parityShellPrompt);
    setServerConfigSnapshot(parityShellServerConfig);
    setReady(true);
    return () => {
      useStore.setState(previousStore, true);
      useComposerDraftStore.setState(previousDrafts, true);
      appAtomRegistry.set(serverConfigAtom, previousConfig);
      appAtomRegistry.set(providersUpdatedAtom, previousProviders);
      appAtomRegistry.set(serverConfigUpdatedAtom, previousUpdated);
    };
  }, []);
  return ready ? <CompactChatShell compactChat={parityCompactChat} /> : null;
}

/** Isolated desktop route registration; no production mobile router types enter this project. */
export function DesktopShellReference() {
  const queryClient = useQueryClient();
  const [router] = useState(() => {
    const root = createRootRouteWithContext<NonNullable<AppRouter["options"]["context"]>>()();
    const route = createRoute({
      getParentRoute: () => root,
      path: "/$threadId",
      component: DesktopReadyShell,
    });
    return createRouter({
      routeTree: root.addChildren([route]),
      context: { queryClient },
      history: createMemoryHistory({ initialEntries: [`/${parityShellThreadId}`] }),
    });
  });
  return (
    <AppAtomRegistryProvider>
      <TooltipProvider>
        <div data-parity-client="desktop" data-parity-surface="shell" className="h-dvh min-w-0">
          <RouterProvider router={router} />
        </div>
      </TooltipProvider>
    </AppAtomRegistryProvider>
  );
}
