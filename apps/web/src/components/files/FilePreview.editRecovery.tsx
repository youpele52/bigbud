import type { ProjectFileEditReadOnlyReason } from "@bigbud/contracts/workspace/project";
import { Button } from "../ui/button";
import type { FileEditDraft } from "./fileEditDrafts";
import { retryFileEditDraft } from "./fileEditDrafts";
import { FilePreviewEditCompare } from "./FilePreview.editCompare";
import { FILE_EDIT_READ_ONLY_COPY } from "./fileEditEligibility";

interface FilePreviewEditRecoveryProps {
  readonly eligible: boolean;
  readonly draft: FileEditDraft | null;
  readonly draftKey: string;
  readonly editing: boolean;
  readonly readOnlyReason: ProjectFileEditReadOnlyReason | null;
  readonly onRefresh: () => void | Promise<void>;
}

export function FilePreviewEditRecovery({
  eligible,
  draft,
  draftKey,
  editing,
  readOnlyReason,
  onRefresh,
}: FilePreviewEditRecoveryProps) {
  if (!eligible || !draft) {
    return readOnlyReason ? (
      <span
        className="text-xs text-muted-foreground"
        title={FILE_EDIT_READ_ONLY_COPY[readOnlyReason]}
      >
        Read only
      </span>
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
        <FilePreviewEditCompare draft={draft} draftKey={draftKey} />
      ) : null}
    </>
  );
}
