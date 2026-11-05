import { Button } from "../ui/button";
import type { FileEditDraft } from "./fileEditDrafts";
import { discardConflictedFileEditDraft, retryFileEditDraft } from "./fileEditDrafts";

interface FilePreviewEditRecoveryProps {
  readonly eligible: boolean;
  readonly draft: FileEditDraft | null;
  readonly draftKey: string;
  readonly editing: boolean;
  readonly executionTargetId?: string | undefined;
  readonly onRefresh: () => void | Promise<void>;
}

export function FilePreviewEditRecovery({
  eligible,
  draft,
  draftKey,
  editing,
  executionTargetId,
  onRefresh,
}: FilePreviewEditRecoveryProps) {
  if (!eligible || !draft) {
    return executionTargetId?.includes("transport=direct-ssh") ? (
      <span className="text-xs text-muted-foreground">Read only</span>
    ) : null;
  }
  return (
    <>
      {draft.status === "error" ? (
        <>
          <Button size="xs" variant="ghost" onClick={() => void onRefresh()}>
            Check disk
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={!draft.retryAllowed}
            onClick={() => retryFileEditDraft(draftKey)}
          >
            Retry save
          </Button>
        </>
      ) : null}
      {draft.status === "conflict" && !draft.diskVerified ? (
        <Button size="xs" variant="ghost" onClick={() => void onRefresh()}>
          Refresh file
        </Button>
      ) : null}
      {draft.status === "conflict" && draft.diskVerified && !editing ? (
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            if (window.confirm("Discard your in-memory draft and use the latest file from disk?")) {
              discardConflictedFileEditDraft(draftKey);
            }
          }}
        >
          Discard draft
        </Button>
      ) : null}
    </>
  );
}
