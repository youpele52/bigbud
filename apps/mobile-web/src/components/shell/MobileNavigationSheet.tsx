import { isBuiltInChatsProject, ProjectId } from "@bigbud/contracts";
import { Chatting01Icon, Comment03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  FolderIcon,
  LaptopMinimalIcon,
  SettingsIcon,
  SquarePenIcon,
  XIcon,
} from "lucide-react";
import type { MobileRecoveryState } from "../../logic/mobileRecovery.types";
import type { MobileConnectionState } from "../../logic/mobileConnection.logic";
import type { StoredMobileSession } from "../../lib/mobileSession";
import { useMobileNewThread } from "../../hooks/useMobileNewThread";
import { useMobileSnapshot } from "../../hooks/useMobileSnapshot";
import {
  sortProjectsForMobile,
  threadsForProject,
  chatThreadsForMobile,
} from "../../lib/mobileModels";
import { cn } from "../../lib/cn";
import {
  Drawer,
  DrawerBackdrop,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHandle,
  DrawerPopup,
  DrawerPortal,
  DrawerTitle,
  DrawerViewport,
} from "../ui/drawer";
import { MobileThreadList } from "../threads/MobileThreadList";
import { MobileNavigationSettings } from "./MobileNavigationSettings";
import {
  MOBILE_NAVIGATION_TRIGGER_ID,
  withoutMobileNavigationView,
  type MobileNavigationView,
} from "./MobileNavigationSheet.logic";
import type { ReactNode } from "react";

interface MobileNavigationSheetProps {
  readonly open: boolean;
  readonly view: MobileNavigationView;
  readonly session: StoredMobileSession | null;
  readonly recoveryState: MobileRecoveryState;
  readonly connection: MobileConnectionState;
  readonly onClose: () => void;
  readonly onOpenChangeComplete?: ((open: boolean) => void) | undefined;
  readonly onViewChange: (view: MobileNavigationView) => void;
  readonly onRetry: () => void;
  readonly onForget: () => void;
}

const rowClassName =
  "flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm text-foreground transition-colors active:bg-accent";

export function MobileNavigationSheet(props: MobileNavigationSheetProps) {
  const navigate = useNavigate();
  const { startNewChat, startNewThread } = useMobileNewThread();
  const { snapshotQuery } = useMobileSnapshot(props.session);
  const snapshot = snapshotQuery.data;
  const projectView = props.view.kind === "project" ? props.view : null;
  const projectId = projectView?.projectId ?? null;
  const title =
    props.view.kind === "settings"
      ? "Settings"
      : props.view.kind === "project"
        ? (snapshot?.projects.find((project) => project.id === projectId)?.title ?? "Project")
        : "Chats";

  function selectThread(threadId: string) {
    void navigate({
      to: "/mobile/thread/$threadId",
      params: { threadId },
      replace: true,
      state: (previous) => withoutMobileNavigationView(previous),
    });
  }

  return (
    <Drawer
      onOpenChange={(nextOpen) => {
        if (!nextOpen) props.onClose();
      }}
      onOpenChangeComplete={props.onOpenChangeComplete}
      open={props.open}
      swipeDirection="down"
      triggerId={MOBILE_NAVIGATION_TRIGGER_ID}
    >
      <DrawerPortal>
        <DrawerBackdrop />
        <DrawerViewport>
          <DrawerPopup finalFocus>
            <DrawerHandle className="h-5" />
            <div
              className="flex shrink-0 items-center justify-between gap-3 border-b border-border/70 px-4 py-2"
              data-base-ui-swipe-ignore=""
            >
              {props.view.kind === "chats" ? (
                <span className="size-11" aria-hidden="true" />
              ) : (
                <button
                  aria-label="Back to Chats"
                  className="inline-flex size-11 items-center justify-center rounded-full text-foreground active:bg-accent"
                  onClick={() => props.onViewChange({ kind: "chats" })}
                  type="button"
                >
                  <ArrowLeftIcon className="size-4" />
                </button>
              )}
              <DrawerTitle className="flex min-w-0 flex-1 items-center justify-center gap-2 truncate text-center">
                {props.view.kind === "chats" ? (
                  <HugeiconsIcon
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted-foreground"
                    icon={Chatting01Icon}
                    size={16}
                    strokeWidth={1.5}
                  />
                ) : null}
                <span className="truncate">{title}</span>
              </DrawerTitle>
              <DrawerClose
                aria-label="Close navigation"
                className="inline-flex size-11 items-center justify-center rounded-lg text-foreground transition-colors active:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              >
                <XIcon className="size-4" />
              </DrawerClose>
            </div>
            <DrawerDescription className="sr-only">
              Switch chats and projects, or manage this mobile connection.
            </DrawerDescription>
            <DrawerContent className="px-3 py-3">
              {props.view.kind === "settings" ? (
                <MobileNavigationSettings
                  connection={props.connection}
                  onForget={props.onForget}
                  onRetry={props.onRetry}
                  recoveryState={props.recoveryState}
                  session={props.session}
                />
              ) : projectView ? (
                <MobileProjectView
                  projectId={ProjectId.makeUnsafe(projectView.projectId)}
                  snapshot={snapshot}
                  onSelectThread={selectThread}
                  onNewThread={() => startNewThread(ProjectId.makeUnsafe(projectView.projectId))}
                />
              ) : (
                <MobileChatsView
                  snapshot={snapshot}
                  onSelectThread={selectThread}
                  onNewChat={() => {
                    props.onClose();
                    startNewChat();
                  }}
                  onProject={(projectId) => props.onViewChange({ kind: "project", projectId })}
                  onSettings={() => props.onViewChange({ kind: "settings" })}
                />
              )}
            </DrawerContent>
            <div
              className="flex shrink-0 items-center justify-end border-t border-border/70 px-4 py-3"
              data-base-ui-swipe-ignore=""
            >
              <DrawerClose className={cn(rowClassName, "w-auto px-3 text-muted-foreground")}>
                Close
              </DrawerClose>
            </div>
          </DrawerPopup>
        </DrawerViewport>
      </DrawerPortal>
    </Drawer>
  );
}

function MobileChatsView({
  snapshot,
  onSelectThread,
  onNewChat,
  onProject,
  onSettings,
}: {
  readonly snapshot: ReturnType<typeof useMobileSnapshot>["snapshotQuery"]["data"];
  readonly onSelectThread: (threadId: string) => void;
  readonly onNewChat: () => void;
  readonly onProject: (projectId: string) => void;
  readonly onSettings: () => void;
}) {
  const threads = snapshot ? chatThreadsForMobile(snapshot) : [];
  const projects = snapshot ? sortProjectsForMobile(snapshot) : [];
  return (
    <div className="grid gap-5">
      <div className="grid gap-1">
        <button className={rowClassName} onClick={onNewChat} type="button">
          <SquarePenIcon className="size-4 text-muted-foreground" />
          <span>New chat</span>
        </button>
        <button className={rowClassName} onClick={onSettings} type="button">
          <SettingsIcon className="size-4 text-muted-foreground" />
          <span>Settings</span>
        </button>
      </div>
      <MobileSheetSection
        icon={
          <HugeiconsIcon
            aria-hidden="true"
            className="size-4"
            icon={Comment03Icon}
            size={16}
            strokeWidth={1.5}
          />
        }
        title="Recents"
      >
        {threads.length > 0 ? (
          <MobileThreadList threads={threads} onSelectThread={onSelectThread} />
        ) : (
          <p className="px-3 py-2 text-xs text-muted-foreground">No chats yet.</p>
        )}
      </MobileSheetSection>
      <MobileSheetSection icon={<LaptopMinimalIcon className="size-4" />} title="Projects">
        {projects.length > 0 ? (
          projects.map((project) => (
            <button
              className={rowClassName}
              key={project.id}
              onClick={() => onProject(project.id)}
              type="button"
            >
              <FolderIcon className="size-4 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{project.title}</span>
            </button>
          ))
        ) : (
          <p className="px-3 py-2 text-xs text-muted-foreground">No projects found.</p>
        )}
      </MobileSheetSection>
    </div>
  );
}

function MobileProjectView({
  projectId,
  snapshot,
  onSelectThread,
  onNewThread,
}: {
  readonly projectId: ProjectId;
  readonly snapshot: ReturnType<typeof useMobileSnapshot>["snapshotQuery"]["data"];
  readonly onSelectThread: (threadId: string) => void;
  readonly onNewThread: () => void;
}) {
  const project = snapshot?.projects.find((candidate) => candidate.id === projectId);
  const threads = snapshot ? threadsForProject(snapshot, projectId) : [];
  if (!project || isBuiltInChatsProject(project.id)) {
    return <p className="px-3 py-6 text-sm text-muted-foreground">Project not found.</p>;
  }
  return (
    <div className="grid gap-3">
      <button className={rowClassName} onClick={onNewThread} type="button">
        <SquarePenIcon className="size-4 text-muted-foreground" />
        <span>New thread in {project.title}</span>
      </button>
      {threads.length > 0 ? (
        <MobileThreadList threads={threads} onSelectThread={onSelectThread} />
      ) : (
        <p className="px-3 py-6 text-xs text-muted-foreground">No threads in this project.</p>
      )}
    </div>
  );
}

function MobileSheetSection({
  title,
  icon,
  children,
}: {
  readonly title: string;
  readonly icon: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="grid gap-1">
      <h2 className="flex items-center gap-2 px-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {icon}
        {title}
      </h2>
      <div className="grid gap-0.5">{children}</div>
    </section>
  );
}
