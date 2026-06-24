import { MessageSquareIcon, SquarePenIcon } from "lucide-react";

import { MobileListAction, MobileListLink } from "../components/MobileAppHeader";
import { MobileFolderIcon } from "../components/MobileFolderIcon";
import { SIDEBAR_ICON_SIZE_CLASS } from "../components/mobileIconSizes";
import { MobileSessionGate } from "../components/MobileSessionGate";
import { useMobileNewThread } from "../hooks/useMobileNewThread";
import { useMobileSnapshot } from "../hooks/useMobileSnapshot";
import { cn } from "../lib/cn";
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
      {() => (
        <nav className="flex flex-col gap-0.5 py-1">
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
              <MessageSquareIcon
                className={cn(SIDEBAR_ICON_SIZE_CLASS, "shrink-0 text-muted-foreground/70")}
              />
            }
            to="/mobile/chats"
          >
            Recents
          </MobileListLink>
          <MobileListLink icon={<MobileFolderIcon />} to="/mobile/projects">
            Projects
          </MobileListLink>
        </nav>
      )}
    </MobileSessionGate>
  );
}
