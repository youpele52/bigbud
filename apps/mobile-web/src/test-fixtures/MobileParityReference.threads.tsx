import { OrchestrationThread } from "@bigbud/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";
import { SidebarThreadRow } from "~/components/sidebar/SidebarThreadRow";
import { TooltipProvider } from "~/components/ui/tooltip";
import { useStore } from "~/stores/main";
import type { SidebarThreadSummary } from "~/models/types/app.types";
import { MobileThreadList } from "../components/threads/MobileThreadList";

const noop = () => {};
const fixtureTime = "2026-11-15T00:00:00.000Z";
const threads = [
  "Review the mobile implementation",
  "A longer thread title that must remain readable on a narrow display",
].map((title, index) =>
  Schema.decodeUnknownSync(OrchestrationThread)({
    id: `parity-list-${index}`,
    projectId: "parity-list-project",
    title,
    modelSelection: { provider: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: fixtureTime,
    updatedAt: fixtureTime,
    deletedAt: null,
    messages: [],
    activities: [],
    checkpoints: [],
    session: null,
  }),
);
const summaries: Record<string, SidebarThreadSummary> = Object.fromEntries(
  threads.map((thread) => [
    thread.id,
    {
      id: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      interactionMode: thread.interactionMode,
      session: null,
      createdAt: thread.createdAt,
      archivedAt: null,
      pinnedAt: null,
      updatedAt: thread.updatedAt,
      latestTurn: null,
      branch: null,
      worktreePath: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    },
  ]),
);

/** Only isolated in-memory sidebar summaries are seeded; no real app/profile is mounted. */
export function MobileParityThreads({ client }: { client: "desktop" | "mobile" }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (client !== "desktop") return;
    const previous = useStore.getState().sidebarThreadsById;
    useStore.setState({ sidebarThreadsById: summaries });
    setReady(true);
    return () => useStore.setState({ sidebarThreadsById: previous });
  }, [client]);
  if (client === "mobile") return <MobileThreadList threads={threads} onSelectThread={noop} />;
  if (!ready) return null;
  return (
    <TooltipProvider>
      <ul className="m-0 w-full list-none space-y-1 p-0" data-parity-thread-list>
        {threads.map((thread) => (
          <SidebarThreadRow
            key={thread.id}
            threadId={thread.id}
            orderedProjectThreadIds={threads.map((item) => item.id)}
            routeThreadId={null}
            selectedThreadIds={new Set()}
            showThreadJumpHints={false}
            jumpLabel={null}
            renamingThreadId={null}
            renamingTitle=""
            setRenamingTitle={noop}
            onRenamingInputMount={noop}
            hasRenameCommitted={() => false}
            markRenameCommitted={noop}
            handleThreadClick={noop}
            navigateToThread={noop}
            handleMultiSelectContextMenu={async () => {}}
            handleThreadContextMenu={async () => {}}
            clearSelection={noop}
            commitRename={async () => {}}
            cancelRename={noop}
            branchThread={async () => {}}
            favoriteThreadIds={new Set()}
            toggleFavoriteThread={async () => {}}
            requestThreadDelete={async () => {}}
            openPrLink={noop}
            pr={null}
          />
        ))}
      </ul>
    </TooltipProvider>
  );
}
