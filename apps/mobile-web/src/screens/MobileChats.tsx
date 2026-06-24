import { MessageSquareTextIcon } from "lucide-react";

import { MobileListSection } from "../components/MobileAppHeader";
import { MobileNewChatFab } from "../components/MobileNewChatFab";
import { SIDEBAR_ICON_SIZE_CLASS } from "../components/mobileIconSizes";
import { MobileSessionGate } from "../components/MobileSessionGate";
import { MobileThreadList } from "../components/MobileThreadList";
import { useMobileNewThread } from "../hooks/useMobileNewThread";
import { useMobileSnapshot } from "../hooks/useMobileSnapshot";
import { chatThreadsForMobile } from "../mobileModels";
import { useMobileSessionState } from "../MobileSessionContext";

export function MobileChats() {
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
            <div className="py-1 pb-24">
              {threads.length === 0 ? (
                <p className="px-1 py-8 text-sm text-muted-foreground">No chats yet.</p>
              ) : (
                <MobileListSection
                  icon={
                    <MessageSquareTextIcon
                      className={`${SIDEBAR_ICON_SIZE_CLASS} shrink-0 text-muted-foreground/70`}
                    />
                  }
                  title="Recents"
                >
                  <MobileThreadList threads={threads} />
                </MobileListSection>
              )}
            </div>
            <MobileNewChatFab ariaLabel="New chat" onClick={startNewChat} />
          </>
        );
      }}
    </MobileSessionGate>
  );
}
