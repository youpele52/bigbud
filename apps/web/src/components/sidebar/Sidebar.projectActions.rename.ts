import { type ProjectId } from "@bigbud/contracts";
import { useCallback, useRef, useState } from "react";
import { newCommandId } from "../../lib/utils";
import { readNativeApi } from "../../rpc/nativeApi";
import { toastManager } from "../ui/toast";

export function useSidebarProjectRenameActions() {
  const [renamingProjectId, setRenamingProjectId] = useState<ProjectId | null>(null);
  const [renamingProjectTitle, setRenamingProjectTitle] = useState("");
  const projectRenamingCommittedRef = useRef(false);
  const projectRenamingInputRef = useRef<HTMLInputElement | null>(null);

  const cancelProjectRename = useCallback(() => {
    setRenamingProjectId(null);
    projectRenamingInputRef.current = null;
  }, []);

  const onProjectRenamingInputMount = useCallback((element: HTMLInputElement | null) => {
    if (element && projectRenamingInputRef.current !== element) {
      projectRenamingInputRef.current = element;
      element.focus();
      element.select();
      return;
    }
    if (element === null && projectRenamingInputRef.current !== null) {
      projectRenamingInputRef.current = null;
    }
  }, []);

  const hasProjectRenameCommitted = useCallback(() => projectRenamingCommittedRef.current, []);

  const markProjectRenameCommitted = useCallback(() => {
    projectRenamingCommittedRef.current = true;
  }, []);

  const commitProjectRename = useCallback(
    async (projectId: ProjectId, newTitle: string, originalTitle: string) => {
      const finishRename = () => {
        setRenamingProjectId((current) => {
          if (current !== projectId) return current;
          projectRenamingInputRef.current = null;
          return null;
        });
      };

      const trimmed = newTitle.trim();
      if (trimmed.length === 0) {
        toastManager.add({
          type: "warning",
          title: "Project title cannot be empty",
        });
        finishRename();
        return;
      }
      if (trimmed === originalTitle) {
        finishRename();
        return;
      }
      const api = readNativeApi();
      if (!api) {
        finishRename();
        return;
      }
      try {
        await api.orchestration.dispatchCommand({
          type: "project.meta.update",
          commandId: newCommandId(),
          projectId,
          title: trimmed,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to rename project",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
      finishRename();
    },
    [],
  );

  return {
    renamingProjectId,
    setRenamingProjectId,
    renamingProjectTitle,
    setRenamingProjectTitle,
    projectRenamingCommittedRef,
    cancelProjectRename,
    onProjectRenamingInputMount,
    hasProjectRenameCommitted,
    markProjectRenameCommitted,
    commitProjectRename,
  };
}
