import type { ThreadId } from "@bigbud/contracts";
import { memo } from "react";

import { BaseMarkdown } from "~/components/common/BaseMarkdown";
import {
  AnnotationComposerPanel,
  formatAnnotationTargetLabel,
} from "~/components/annotations/AnnotationComposerPanel";
import { Textarea } from "~/components/ui/textarea";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";

import { NotesPanelList } from "./NotesPanel.list";
import { useNotesPanelState } from "./NotesPanel.logic";

interface NotesPanelProps {
  activeThreadId?: ThreadId | null;
}

export const NotesPanelContent = memo(function NotesPanelContent({
  activeThreadId,
}: NotesPanelProps) {
  const state = useNotesPanelState({ activeThreadId: activeThreadId ?? null });

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {state.selectedNoteId ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex items-center justify-between gap-2 border-b border-border p-2">
            <div className="truncate text-sm font-medium">
              {state.selectedNote?.title ?? "Notes"}
            </div>
            <div className="flex items-center gap-2">
              <ToggleGroup
                aria-label="Switch note editor view"
                variant="toolbar"
                size="xs"
                value={[state.previewMode ? "preview" : "edit"]}
                onValueChange={(value) => {
                  const next = value[0];
                  if (next === "edit") {
                    state.setPreviewMode(false);
                  }
                  if (next === "preview") {
                    state.setPreviewMode(true);
                  }
                }}
              >
                <Toggle aria-label="Edit note" value="edit">
                  Edit
                </Toggle>
                <Toggle aria-label="Preview note" value="preview">
                  Preview
                </Toggle>
              </ToggleGroup>
            </div>
          </div>
          <div
            className="min-h-0 flex-1 overflow-auto p-3"
            onContextMenu={(event) => void state.handleAnnotateSelection(event)}
          >
            {state.previewMode ? (
              <BaseMarkdown
                text={state.selectedContent}
                cwd={state.cwd}
                isStreaming={false}
                preserveLineBreaks
                className="note-markdown"
              />
            ) : (
              <Textarea
                ref={state.editorRef}
                value={state.selectedContent}
                onChange={(event) => state.setSelectedContent(event.target.value)}
                className="h-full min-h-full !bg-background"
                unstyled={false}
              />
            )}
            {state.annotationRange && activeThreadId ? (
              <div className="sticky bottom-3 mx-auto mt-3">
                <AnnotationComposerPanel
                  targetLabel={formatAnnotationTargetLabel(state.annotationRange)}
                  onCancel={() => state.setAnnotationRange(null)}
                  onSubmit={state.handleCreateAnnotation}
                />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      <NotesPanelList
        loading={state.loading}
        error={state.error}
        saving={state.saving}
        notes={state.notes}
        selectedNoteId={state.selectedNoteId}
        projectId={state.projectId}
        resolvedScope={state.resolvedScope}
        renamingNoteId={state.renamingNoteId}
        renamingTitle={state.renamingTitle}
        setRenamingTitle={state.setRenamingTitle}
        onRenamingInputMount={state.onRenamingInputMount}
        hasRenameCommitted={state.hasRenameCommitted}
        markRenameCommitted={state.markRenameCommitted}
        setScope={state.setScope}
        onCreate={state.handleCreate}
        onSelectNote={state.setSelectedNoteId}
        onContextMenu={state.handleNoteContextMenu}
        onCommitRename={state.commitRename}
        onCancelRename={state.cancelRename}
      />
    </div>
  );
});
