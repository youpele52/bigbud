import { QueryClient } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRouter,
} from "@tanstack/react-router";
import { DraftOwnershipCoordinator } from "~/components/DraftOwnershipCoordinator";
import { useCompactChatThread } from "~/hooks/useCompactChatThread";
import { EventRouter } from "~/routes/-__root.logic";
import { CompactChatShell } from "../FloatingAssistantShell";

function CompactSynchronizationHarness() {
  const compactChat = useCompactChatThread();
  return (
    <>
      <DraftOwnershipCoordinator scope="compact" repairOnStartup={false} />
      <EventRouter ownedThreadId={compactChat.threadId} />
      <CompactChatShell compactChat={compactChat} />
    </>
  );
}

export function createCompactRouter(queryClient: QueryClient) {
  const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
    component: CompactSynchronizationHarness,
  });
  return createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
    context: { queryClient },
  });
}
