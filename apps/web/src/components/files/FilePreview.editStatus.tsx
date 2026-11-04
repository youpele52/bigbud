import type { FileEditDraft } from "./fileEditDrafts";

interface FilePreviewEditStatusProps {
  readonly draft: FileEditDraft | null;
  readonly eligible: boolean;
  readonly readError: string | null;
}

export function FilePreviewEditStatus({ draft, eligible, readError }: FilePreviewEditStatusProps) {
  if (!eligible || !draft) return null;
  return (
    <>
      {readError ? (
        <div role="alert" className="border-b border-border px-3 py-1 text-xs text-destructive">
          {readError} Showing your in-memory copy; verify the file when the connection returns.
        </div>
      ) : null}
      {draft.status === "error" || draft.status === "conflict" ? (
        <div role="alert" className="border-b border-border px-3 py-1 text-xs text-warning">
          {draft.message}
        </div>
      ) : null}
    </>
  );
}
