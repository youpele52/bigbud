import { isBuiltInChatsProject, ProjectId } from "@bigbud/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  FolderIcon,
  MessageSquareTextIcon,
  RefreshCwIcon,
  SettingsIcon,
  SquarePenIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";
import { Dialog } from "@base-ui/react/dialog";

import type { MobileRecoveryState } from "../../logic/mobileRecovery.types";
import type { StoredMobileSession } from "../../lib/mobileSession";
import { useMobileNewThread } from "../../hooks/useMobileNewThread";
import { useMobileSnapshot } from "../../hooks/useMobileSnapshot";
import {
  sortProjectsForMobile,
  threadsForProject,
  chatThreadsForMobile,
} from "../../lib/mobileModels";
import { cn } from "../../lib/cn";
import { useTheme } from "../../theme/useTheme";
import { Button } from "../ui/button";
import { MobileThreadList } from "../threads/MobileThreadList";
import {
  sanitizeMobileBackendOrigin,
  withoutMobileNavigationView,
  type MobileNavigationView,
} from "./MobileNavigationSheet.logic";
import type { ReactNode } from "react";

interface MobileNavigationSheetProps {
  readonly open: boolean;
  readonly view: MobileNavigationView;
  readonly session: StoredMobileSession | null;
  readonly recoveryState: MobileRecoveryState;
  readonly onClose: () => void;
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
    <Dialog.Root open={props.open} onOpenChange={(nextOpen) => !nextOpen && props.onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/28 transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Viewport className="fixed inset-0 z-50 flex items-end justify-center px-2 pt-8">
          <Dialog.Popup className="flex max-h-[calc(100dvh-2rem)] min-h-0 w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl border border-border bg-popover pb-[env(safe-area-inset-bottom)] text-popover-foreground shadow-2xl outline-none transition-transform data-ending-style:translate-y-4 data-starting-style:translate-y-4">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
              {props.view.kind === "chats" ? (
                <span className="size-9" aria-hidden="true" />
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
              <Dialog.Title className="min-w-0 flex-1 truncate text-center text-sm font-semibold">
                {title}
              </Dialog.Title>
              <Dialog.Close
                aria-label="Close navigation"
                className="inline-flex size-11 items-center justify-center rounded-full text-foreground active:bg-accent"
              >
                <XIcon className="size-4" />
              </Dialog.Close>
            </div>
            <Dialog.Description className="sr-only">
              Switch chats and projects, or manage this mobile connection.
            </Dialog.Description>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3">
              {props.view.kind === "settings" ? (
                <MobileNavigationSettings {...props} />
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
            </div>
            <div className="flex shrink-0 items-center justify-end border-t border-border/70 px-4 py-3">
              <Dialog.Close className={cn(rowClassName, "w-auto px-3 text-muted-foreground")}>
                Close
              </Dialog.Close>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
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
      <MobileSheetSection icon={<MessageSquareTextIcon className="size-4" />} title="Recents">
        {threads.length > 0 ? (
          <MobileThreadList threads={threads} onSelectThread={onSelectThread} />
        ) : (
          <p className="px-3 py-2 text-xs text-muted-foreground">No chats yet.</p>
        )}
      </MobileSheetSection>
      <MobileSheetSection icon={<FolderIcon className="size-4" />} title="Projects">
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

function MobileNavigationSettings({
  session,
  recoveryState,
  onRetry,
  onForget,
}: MobileNavigationSheetProps) {
  const { theme, setTheme } = useTheme();
  const [confirmForget, setConfirmForget] = useState(false);
  const origin = session ? sanitizeMobileBackendOrigin(session.backendBaseUrl) : null;
  const expiresAt = session ? new Date(session.expiresAt).toLocaleString() : "Not paired";

  if (confirmForget) {
    return (
      <div className="grid gap-4 px-3 py-2">
        <div className="grid gap-1">
          <h2 className="text-sm font-semibold">Forget this connection?</h2>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Removes this connection and its drafts from this browser. It does not revoke the desktop
            authorization.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            className="min-h-11"
            onClick={() => setConfirmForget(false)}
            size="sm"
            variant="outline"
          >
            Keep connection
          </Button>
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-md bg-destructive px-3 text-sm text-destructive-foreground"
            onClick={onForget}
            type="button"
          >
            Forget connection
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-5 px-3 py-2">
      <section className="grid gap-2">
        <h2 className="text-sm font-semibold">Appearance</h2>
        <label className="grid gap-1 text-xs text-muted-foreground" htmlFor="mobile-theme">
          Theme
          <select
            className="min-h-11 rounded-lg border border-border bg-background px-3 text-sm text-foreground"
            id="mobile-theme"
            onChange={(event) => setTheme(event.target.value as "system" | "light" | "dark")}
            value={theme}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </section>
      <section className="grid gap-2">
        <h2 className="text-sm font-semibold">Connection</h2>
        <dl className="grid gap-2 text-xs">
          <div>
            <dt className="text-muted-foreground">Backend</dt>
            <dd className="truncate text-foreground">{origin ?? "Unavailable"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Status</dt>
            <dd className="text-foreground">{recoveryState.freshness}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Stored expiry</dt>
            <dd className="text-foreground">{expiresAt}</dd>
          </div>
        </dl>
        <Button className="min-h-11 w-fit" onClick={onRetry} size="sm" variant="outline">
          <RefreshCwIcon className="size-3.5" /> Retry connection
        </Button>
      </section>
      <section className="grid gap-2">
        <h2 className="text-sm font-semibold">Pairing help</h2>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Open a new pairing link from the desktop app if this connection expires or cannot
          reconnect.
        </p>
      </section>
      <section className="grid gap-2 border-t border-border/70 pt-4">
        <Button
          className="min-h-11 w-fit"
          onClick={() => setConfirmForget(true)}
          size="sm"
          variant="outline"
        >
          Forget this connection
        </Button>
      </section>
    </div>
  );
}
