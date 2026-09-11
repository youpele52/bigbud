import { Comment03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { LaptopMinimalIcon, SquarePenIcon } from "lucide-react";

import {
  MobileListAction,
  MobileListLink,
  MobileListSection,
} from "../components/shell/MobileAppHeader";
import { SIDEBAR_ICON_SIZE_CLASS } from "../components/threads/threads.iconSizes";
import { MobileSessionGate } from "../components/shell/MobileSessionGate";
import { MobileThreadList } from "../components/threads/MobileThreadList";
import { useMobileNewThread } from "../hooks/useMobileNewThread";
import { useMobileSnapshot } from "../hooks/useMobileSnapshot";
import { cn } from "../lib/cn";
import { chatThreadsForMobile } from "../lib/mobileModels";
import { useMobileSessionState } from "../context/MobileSessionContext";

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
                  <LaptopMinimalIcon
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
                    <HugeiconsIcon
                      aria-hidden="true"
                      className={cn(SIDEBAR_ICON_SIZE_CLASS, "shrink-0 text-muted-foreground/70")}
                      icon={Comment03Icon}
                      size={14}
                      strokeWidth={1.5}
                    />
                  }
                  title="Recents"
                >
                  <MobileThreadList threads={threads} />
                </MobileListSection>
              ) : null}
            </div>
          </>
        );
      }}
    </MobileSessionGate>
  );
}
