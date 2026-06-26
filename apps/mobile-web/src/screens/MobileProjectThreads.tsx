import type { ProjectId } from "@bigbud/contracts";
import { FolderOpenIcon } from "lucide-react";

import { MobileListSection } from "../components/shell/MobileAppHeader";
import { MobileNewChatFab } from "../components/threads/MobileNewChatFab";
import { SIDEBAR_ICON_SIZE_CLASS } from "../components/threads/threads.iconSizes";
import { MobileSessionGate } from "../components/shell/MobileSessionGate";
import { MobileThreadList } from "../components/threads/MobileThreadList";
import { useMobileNewThread } from "../hooks/useMobileNewThread";
import { useMobileSnapshot } from "../hooks/useMobileSnapshot";
import { threadsForProject } from "../lib/mobileModels";
import { useMobileSessionState } from "../context/MobileSessionContext";

export function MobileProjectThreads({ projectId }: { projectId: ProjectId }) {
  const { session } = useMobileSessionState();
  const { snapshotQuery, connectionError } = useMobileSnapshot(session);
  const { startNewThread } = useMobileNewThread();

  return (
    <MobileSessionGate
      connectionError={connectionError}
      session={session}
      snapshotQuery={snapshotQuery}
    >
      {(snapshot) => {
        const project = snapshot.projects.find((candidate) => candidate.id === projectId);
        const threads = threadsForProject(snapshot, projectId);
        if (!project) {
          return <p className="px-1 py-8 text-sm text-muted-foreground">Project not found.</p>;
        }
        return (
          <>
            <div className="py-1 pb-24">
              {threads.length === 0 ? (
                <p className="px-1 py-8 text-sm text-muted-foreground">
                  No threads in {project.title}.
                </p>
              ) : (
                <MobileListSection
                  icon={
                    <FolderOpenIcon
                      className={`${SIDEBAR_ICON_SIZE_CLASS} shrink-0 text-muted-foreground/70`}
                    />
                  }
                  title={project.title}
                >
                  <MobileThreadList threads={threads} />
                </MobileListSection>
              )}
            </div>
            <MobileNewChatFab ariaLabel="New thread" onClick={() => startNewThread(projectId)} />
          </>
        );
      }}
    </MobileSessionGate>
  );
}
