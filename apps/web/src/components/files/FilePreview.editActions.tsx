import { QuillWrite02Icon, SaveIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";

import "./FilePreview.editActions.css";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { isRecentFileSave, SAVED_CONFIRMATION_MS } from "./FilePreview.editActions.logic";
import type { FileEditDraft } from "./fileEditDrafts";

interface FilePreviewEditActionsProps {
  readonly eligible: boolean;
  readonly draft: FileEditDraft | null;
  readonly editing: boolean;
  readonly readUnavailable: boolean;
  readonly onToggle: () => void;
}

export function FilePreviewEditActions({
  eligible,
  draft,
  editing,
  readUnavailable,
  onToggle,
}: FilePreviewEditActionsProps) {
  const [expiredSave, setExpiredSave] = useState<number | null>(null);
  const savedAt = draft?.status === "saved" ? draft.savedAt : null;
  useEffect(() => {
    if (savedAt === null || !isRecentFileSave(savedAt, Date.now())) return;
    const timer = setTimeout(
      () => setExpiredSave(savedAt),
      Math.max(0, savedAt + SAVED_CONFIRMATION_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [savedAt]);

  if (!eligible || !draft) return null;
  const recentlySaved =
    savedAt !== null && expiredSave !== savedAt && isRecentFileSave(savedAt, Date.now());
  const status =
    readUnavailable && draft.status === "saved"
      ? "Read unavailable"
      : {
          saved: "Saved",
          pending: "Unsaved",
          saving: "Saving…",
          error: "Save failed",
          conflict: "Conflict",
        }[draft.status];
  const showSaveIcon =
    !readUnavailable &&
    (draft.status === "saved" || draft.status === "saving" || draft.status === "pending");
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={editing ? "Preview file" : "Edit file"}
              aria-pressed={editing}
              onClick={onToggle}
            >
              <HugeiconsIcon aria-hidden="true" icon={QuillWrite02Icon} />
            </Button>
          }
        />
        <TooltipPopup side="bottom">{editing ? "Preview file" : "Edit file"}</TooltipPopup>
      </Tooltip>
      <span
        role="status"
        className={
          draft.status === "error" || draft.status === "conflict"
            ? "text-xs text-destructive"
            : draft.status === "pending"
              ? "text-xs text-warning"
              : draft.status === "saving"
                ? "text-xs text-info"
                : recentlySaved
                  ? "text-xs text-success"
                  : "text-xs text-muted-foreground"
        }
      >
        {showSaveIcon ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  aria-label={status}
                  className="inline-flex size-6 items-center justify-center"
                >
                  <HugeiconsIcon
                    aria-hidden="true"
                    icon={SaveIcon}
                    size={14}
                    className={draft.status === "saving" ? "file-preview-save-sway" : undefined}
                  />
                  <span className="sr-only">{status}</span>
                </span>
              }
            />
            <TooltipPopup side="bottom">{status}</TooltipPopup>
          </Tooltip>
        ) : (
          status
        )}
      </span>
    </>
  );
}
