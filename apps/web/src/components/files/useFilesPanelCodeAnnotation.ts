import type { ThreadId } from "@bigbud/contracts";
import { useCallback } from "react";

import { useComposerDraftStore } from "../../stores/composer";
import type { CodeAnnotationDraft } from "./FilePreview";
import { makeAnnotationId } from "./FilesPanel.shared";

/** Adds a code annotation for the previewed file to the active thread's composer draft. */
export function useFilesPanelCodeAnnotation(input: {
  readonly activeThreadId: ThreadId | null | undefined;
  readonly activeWorkspaceRoot: string | null;
  readonly activeProjectName: string | undefined;
  readonly previewPath: string | null;
}) {
  const { activeThreadId, activeWorkspaceRoot, activeProjectName, previewPath } = input;
  const addAnnotation = useComposerDraftStore((state) => state.addAnnotation);
  return useCallback(
    (annotation: CodeAnnotationDraft) => {
      if (!activeThreadId || !activeWorkspaceRoot || !previewPath) return;
      addAnnotation(activeThreadId, {
        id: makeAnnotationId(),
        kind: "code",
        comment: annotation.comment,
        intent: annotation.intent,
        createdAt: new Date().toISOString(),
        file: {
          ...(activeProjectName ? { projectName: activeProjectName } : {}),
          cwd: activeWorkspaceRoot,
          relativePath: previewPath,
        },
        selection: {
          startLine: annotation.startLine,
          endLine: annotation.endLine,
          text: annotation.text,
        },
      });
    },
    [activeProjectName, activeThreadId, activeWorkspaceRoot, addAnnotation, previewPath],
  );
}
