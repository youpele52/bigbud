import { ArchiveIcon, ArchiveX } from "lucide-react";
import { isBuiltInChatsProject, type ThreadId } from "@bigbud/contracts";
import { useCallback, useMemo, useState } from "react";
import { useSettings } from "../../hooks/useSettings";
import { useStore } from "../../stores/main";
import { useThreadActions } from "../../hooks/useThreadActions";
import { formatRelativeTimeLabel } from "../../utils/timestamp";
import { readNativeApi } from "../../rpc/nativeApi";
import { ConfirmationPanel } from "../common/ConfirmationPanel";
import { AlertDialog, AlertDialogPopup } from "../ui/alert-dialog";
import { toastManager } from "../ui/toast";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { ProjectFavicon } from "../project/ProjectFavicon";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

export function ArchivedThreadsPanel() {
  const appSettings = useSettings();
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const { unarchiveThread, deleteThread } = useThreadActions();
  const [pendingDeleteConfirmation, setPendingDeleteConfirmation] = useState<{
    threadId: ThreadId;
    title: string;
  } | null>(null);
  const archivedGroups = useMemo(() => {
    const projectById = new Map(projects.map((project) => [project.id, project] as const));
    return [...projectById.values()]
      .map((project) => ({
        project,
        threads: threads
          .filter(
            (thread) =>
              thread.projectId === project.id &&
              thread.archivedAt !== null &&
              thread.deletingAt === null,
          )
          .toSorted((left, right) => {
            const leftKey = left.archivedAt ?? left.createdAt;
            const rightKey = right.archivedAt ?? right.createdAt;
            return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
          }),
      }))
      .filter((group) => group.threads.length > 0);
  }, [projects, threads]);

  const handleArchivedThreadContextMenu = useCallback(
    async (threadId: ThreadId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "unarchive", label: "Unarchive" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

      if (clicked === "unarchive") {
        try {
          await unarchiveThread(threadId);
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Failed to unarchive thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
        return;
      }

      if (clicked === "delete") {
        const thread = threads.find((entry) => entry.id === threadId);
        if (!thread) {
          return;
        }
        if (appSettings.confirmThreadDelete) {
          setPendingDeleteConfirmation({ threadId, title: thread.title });
          return;
        }
        await deleteThread(threadId);
      }
    },
    [appSettings.confirmThreadDelete, deleteThread, threads, unarchiveThread],
  );

  return (
    <SettingsPageContainer>
      {archivedGroups.length === 0 ? (
        <SettingsSection title="Archived threads">
          <Empty className="min-h-88">
            <EmptyMedia variant="icon">
              <ArchiveIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No archived threads</EmptyTitle>
              <EmptyDescription>Archived threads will appear here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </SettingsSection>
      ) : (
        archivedGroups.map(({ project, threads: projectThreads }) => (
          <SettingsSection
            key={project.id}
            title={project.name}
            icon={
              isBuiltInChatsProject(project.id) ? undefined : <ProjectFavicon cwd={project.cwd} />
            }
          >
            {projectThreads.map((thread) => (
              <fieldset
                key={thread.id}
                className="min-w-0 border-0 border-t border-border px-4 py-3 first:border-t-0 sm:px-5"
                onContextMenu={(event) => {
                  event.preventDefault();
                  void handleArchivedThreadContextMenu(thread.id, {
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
              >
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-sm font-medium text-foreground">{thread.title}</h3>
                  <p className="text-xs text-muted-foreground">
                    Archived {formatRelativeTimeLabel(thread.archivedAt ?? thread.createdAt)}
                    {" \u00b7 Created "}
                    {formatRelativeTimeLabel(thread.createdAt)}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 cursor-pointer gap-1.5 px-2.5"
                  onClick={() =>
                    void unarchiveThread(thread.id).catch((error) => {
                      toastManager.add({
                        type: "error",
                        title: "Failed to unarchive thread",
                        description: error instanceof Error ? error.message : "An error occurred.",
                      });
                    })
                  }
                >
                  <ArchiveX className="size-3.5" />
                  <span>Unarchive</span>
                </Button>
              </fieldset>
            ))}
          </SettingsSection>
        ))
      )}

      <AlertDialog
        open={pendingDeleteConfirmation !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDeleteConfirmation(null);
          }
        }}
      >
        <AlertDialogPopup className="max-w-sm p-0" bottomStickOnMobile={false}>
          {pendingDeleteConfirmation ? (
            <ConfirmationPanel
              title={`Delete thread "${pendingDeleteConfirmation.title}"?`}
              description="This permanently clears conversation history for this thread."
              cancelLabel="Cancel"
              confirmLabel="Delete"
              confirmVariant="destructive"
              onCancel={() => setPendingDeleteConfirmation(null)}
              onConfirm={() => {
                const threadId = pendingDeleteConfirmation.threadId;
                setPendingDeleteConfirmation(null);
                void deleteThread(threadId);
              }}
            />
          ) : null}
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsPageContainer>
  );
}
