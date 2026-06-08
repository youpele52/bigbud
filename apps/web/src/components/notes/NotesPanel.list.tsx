import { type NoteId, type ProjectId } from "@bigbud/contracts";
import { FilePlusIcon } from "lucide-react";

import { resolveThreadRowClassName } from "~/components/sidebar/Sidebar.logic";
import { Button } from "~/components/ui/button";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { formatRelativeTimeLabel } from "~/utils/timestamp";
import {
  BIGBUD_FILES_PANEL_DRAG_MIME,
  serializeFilesPanelDragEntry,
} from "../files/filesPanel.dnd";

export type NotesListItem = {
  noteId: NoteId;
  projectId: ProjectId | null;
  title: string;
  absolutePath: string;
  createdAt: string;
  updatedAt: string;
};

interface NotesPanelListProps {
  loading: boolean;
  error: string | null;
  saving: boolean;
  notes: ReadonlyArray<NotesListItem>;
  selectedNoteId: NoteId | null;
  projectId: string | null;
  resolvedScope: "project" | "global";
  renamingNoteId: NoteId | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  onRenamingInputMount: (element: HTMLInputElement | null) => void;
  hasRenameCommitted: () => boolean;
  markRenameCommitted: () => void;
  setScope: (scope: "project" | "global") => void;
  onCreate: () => Promise<void>;
  onSelectNote: (noteId: NoteId) => void;
  onContextMenu: (note: NotesListItem, position: { x: number; y: number }) => Promise<void>;
  onCommitRename: (noteId: NoteId, newTitle: string, originalTitle: string) => Promise<void>;
  onCancelRename: () => void;
}

export function NotesPanelList(props: NotesPanelListProps) {
  return (
    <div
      className={[
        "flex shrink-0 flex-col",
        props.selectedNoteId ? "w-56 border-l border-border" : "w-full",
      ].join(" ")}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border p-2">
        <ToggleGroup
          aria-label="Switch notes scope"
          variant="toolbar"
          size="xs"
          value={[props.resolvedScope]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "project" || next === "global") {
              props.setScope(next);
            }
          }}
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle aria-label="Global notes" value="global">
                  Global
                </Toggle>
              }
            />
            <TooltipPopup side="bottom" className="max-w-56 whitespace-normal leading-snug">
              Browse notes from every project in one place, including global notes that are not tied
              to a specific project.
            </TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle aria-label="Project notes" disabled={!props.projectId} value="project">
                  Project
                </Toggle>
              }
            />
            <TooltipPopup side="bottom" className="max-w-56 whitespace-normal leading-snug">
              Focus on notes for the currently active project only. This keeps the list scoped to
              the work you are in right now.
            </TooltipPopup>
          </Tooltip>
        </ToggleGroup>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                onClick={() => void props.onCreate()}
                disabled={props.saving}
              >
                <FilePlusIcon className="size-3.5" />
              </Button>
            }
          />
          <TooltipPopup side="bottom">Create a new note.</TooltipPopup>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {props.loading ? (
          <div className="p-2 text-sm text-muted-foreground">Loading notes...</div>
        ) : null}
        {props.error ? <div className="p-2 text-sm text-destructive">{props.error}</div> : null}
        {!props.loading && props.notes.length === 0 ? (
          <div className="p-2 text-sm text-muted-foreground">No notes yet.</div>
        ) : null}
        <div className="space-y-1">
          {props.notes.map((note) => (
            <button
              key={note.noteId}
              type="button"
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "copy";
                event.dataTransfer.setData(
                  BIGBUD_FILES_PANEL_DRAG_MIME,
                  serializeFilesPanelDragEntry({
                    name: `${note.title}.md`,
                    path: note.absolutePath,
                    entryKind: "file",
                  }),
                );
                event.dataTransfer.setData("text/plain", note.title);
              }}
              onClick={() => props.onSelectNote(note.noteId)}
              onContextMenu={(event) => {
                event.preventDefault();
                void props.onContextMenu(note, {
                  x: event.clientX,
                  y: event.clientY,
                });
              }}
              className={resolveThreadRowClassName({
                isActive: props.selectedNoteId === note.noteId,
                isSelected: false,
              })}
            >
              <div className="flex min-w-0 items-center gap-2">
                {props.renamingNoteId === note.noteId ? (
                  <input
                    ref={props.onRenamingInputMount}
                    className="min-w-0 flex-1 truncate rounded border border-ring bg-transparent px-0.5 text-sm outline-none sm:text-xs"
                    value={props.renamingTitle}
                    onChange={(event) => props.setRenamingTitle(event.target.value)}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter") {
                        event.preventDefault();
                        props.markRenameCommitted();
                        void props.onCommitRename(note.noteId, props.renamingTitle, note.title);
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        props.markRenameCommitted();
                        props.onCancelRename();
                      }
                    }}
                    onBlur={() => {
                      if (!props.hasRenameCommitted()) {
                        void props.onCommitRename(note.noteId, props.renamingTitle, note.title);
                      }
                    }}
                    onClick={(event) => event.stopPropagation()}
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate text-xs font-medium" title={note.title}>
                    {note.title}
                  </span>
                )}
                <span className="shrink-0 text-[11px] text-muted-foreground/80">
                  {formatRelativeTimeLabel(note.updatedAt)}
                </span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
