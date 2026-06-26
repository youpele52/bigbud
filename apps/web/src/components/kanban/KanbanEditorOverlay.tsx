import { type KanbanStatus } from "@bigbud/contracts";
import { Maximize2Icon, Minimize2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import { BaseMarkdown } from "~/components/common/BaseMarkdown";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { cn } from "~/lib/utils";

const KANBAN_STATUSES: ReadonlyArray<{ status: KanbanStatus; label: string }> = [
  { status: "backlog", label: "Backlog" },
  { status: "todo", label: "Todo" },
  { status: "ongoing", label: "Ongoing" },
  { status: "done", label: "Done" },
];

interface KanbanEditorOverlayProps {
  content: string;
  cwd: string | undefined;
  error: string | null;
  mode: "create" | "edit";
  saving: boolean;
  selectedStatus: KanbanStatus;
  title: string;
  onCancel: () => void;
  onContentChange: (content: string) => void;
  onDelete: (() => Promise<void>) | null;
  onSave: () => Promise<void>;
  onStatusChange: (status: KanbanStatus) => void;
  onTitleChange: (title: string) => void;
}

export function KanbanEditorOverlay({
  content,
  cwd,
  error,
  mode,
  saving,
  selectedStatus,
  title,
  onCancel,
  onContentChange,
  onDelete,
  onSave,
  onStatusChange,
  onTitleChange,
}: KanbanEditorOverlayProps) {
  const [previewMode, setPreviewMode] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || saving) return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel, saving]);

  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center bg-background/55 px-4 py-6 backdrop-blur-[1px]"
      onClick={(event) => {
        if (event.target !== event.currentTarget || saving) return;
        onCancel();
      }}
    >
      <div
        className={cn(
          "flex overflow-hidden rounded-[20px] border border-border bg-card p-3.5 shadow-[0_18px_54px_rgba(0,0,0,0.24)]",
          isExpanded
            ? "h-[85%] w-[85%]"
            : "h-[26rem] min-h-[20rem] w-[min(32rem,calc(50%-1rem))] min-w-[20rem] max-w-[calc(50%-1rem)] max-h-[calc(50%-1.5rem)] resize",
        )}
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="mb-2.5 flex items-center justify-between gap-2">
            <div className="text-sm font-medium text-foreground">
              {mode === "create" ? "New task" : "Edit task"}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={isExpanded ? "Exit fullscreen editor" : "Enter fullscreen editor"}
              aria-pressed={isExpanded}
              onClick={() => setIsExpanded((current) => !current)}
            >
              {isExpanded ? <Minimize2Icon /> : <Maximize2Icon />}
            </Button>
          </div>
          {error ? <div className="mb-3 text-sm text-destructive">{error}</div> : null}
          <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Kanban status">
            {KANBAN_STATUSES.map((option) => (
              <button
                key={option.status}
                type="button"
                aria-pressed={selectedStatus === option.status}
                className={cn(
                  "h-7 rounded-full border-0 px-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selectedStatus === option.status &&
                    "bg-foreground/8 font-semibold text-foreground",
                )}
                onClick={() => onStatusChange(option.status)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-hidden">
            <Input value={title} onChange={(event) => onTitleChange(event.target.value)} />
            <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
              {previewMode ? (
                <div className="h-full min-w-0 overflow-x-hidden overflow-y-auto px-2">
                  <BaseMarkdown
                    text={content}
                    cwd={cwd}
                    isStreaming={false}
                    preserveLineBreaks
                    className="note-markdown break-words"
                  />
                </div>
              ) : (
                <Textarea
                  value={content}
                  onChange={(event) => onContentChange(event.target.value)}
                  className="h-full min-h-full min-w-0 !bg-background [&_textarea]:h-full [&_textarea]:min-h-full [&_textarea]:overflow-wrap-anywhere [&_textarea]:overflow-y-auto [&_textarea]:break-words [&_textarea]:whitespace-pre-wrap [&_textarea]:[field-sizing:fixed]"
                />
              )}
            </div>
          </div>
          <div className="mt-3 flex shrink-0 items-center justify-between gap-2">
            <ToggleGroup
              aria-label="Switch kanban task editor view"
              variant="toolbar"
              size="xs"
              value={[previewMode ? "preview" : "edit"]}
              onValueChange={(value) => {
                const next = value[0];
                if (next === "edit") {
                  setPreviewMode(false);
                }
                if (next === "preview") {
                  setPreviewMode(true);
                }
              }}
            >
              <Toggle aria-label="Edit task content" value="edit">
                Edit
              </Toggle>
              <Toggle aria-label="Preview task content" value="preview">
                Preview
              </Toggle>
            </ToggleGroup>
            <div className="flex items-center gap-2">
              {onDelete ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => void onDelete()}
                  className="h-9 rounded-[10px] px-3 text-sm text-destructive hover:bg-destructive/10 hover:text-destructive"
                  disabled={saving}
                >
                  Delete
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                onClick={onCancel}
                className="h-9 rounded-[10px] border-border bg-foreground/4 px-3 text-sm"
                disabled={saving}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => void onSave()}
                className="h-9 rounded-[10px] px-3 text-sm"
                disabled={saving || title.trim().length === 0}
              >
                {mode === "create" ? "Create" : "Save"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
