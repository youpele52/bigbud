import { FolderOpenIcon, MessageSquareTextIcon, SquarePenIcon } from "lucide-react";

import { MobileListAction, MobileListLink, MobileListSection } from "../components/MobileAppHeader";
import { MobileNewChatFab } from "../components/MobileNewChatFab";
import { SIDEBAR_ICON_SIZE_CLASS } from "../components/mobileIconSizes";
import { MobileSessionGate } from "../components/MobileSessionGate";
import { MobileThreadList } from "../components/MobileThreadList";
import { useMobileNewThread } from "../hooks/useMobileNewThread";
import { useMobileSnapshot } from "../hooks/useMobileSnapshot";
import { cn } from "../lib/cn";
import { chatThreadsForMobile } from "../mobileModels";
import { useMobileSessionState } from "../MobileSessionContext";

export function MobileLaunch() {
  const { session } = useMobileSessionState();
  const { snapshotQuery, connectionError } = useMobileSnapshot(session);
  const { startNewChat } = useMobileNewThread();

  return (
    <MobileSessionGate
      connectionError={connectionError}
      session={session}
      snapshotQuery={snapshotQuery}
    >
      {(snapshot) => {
        const threads = chatThreadsForMobile(snapshot);
        return (
          <>
            <div className="flex flex-col gap-0.5 py-1 pb-24">
              <MobileListAction
                icon={
                  <SquarePenIcon
                    className={cn(SIDEBAR_ICON_SIZE_CLASS, "shrink-0 text-muted-foreground/70")}
                  />
                }
                onClick={startNewChat}
              >
                New chat
              </MobileListAction>
              <MobileListLink
                icon={
                  <FolderOpenIcon
                    className={cn(SIDEBAR_ICON_SIZE_CLASS, "shrink-0 text-muted-foreground/70")}
                  />
                }
                to="/mobile/projects"
              >
                Projects
              </MobileListLink>
              {threads.length > 0 ? (
                <MobileListSection
                  className="mt-2"
                  icon={
                    <MessageSquareTextIcon
                      className={cn(SIDEBAR_ICON_SIZE_CLASS, "shrink-0 text-muted-foreground/70")}
                    />
                  }
                  title="Recents"
                >
                  <MobileThreadList threads={threads} />
                </MobileListSection>
              ) : null}
            </div>
            <MobileNewChatFab ariaLabel="New chat" onClick={startNewChat} />
          </>
        );
      }}
    </MobileSessionGate>
  );
}
