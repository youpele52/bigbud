import { useCallback, useEffect, useSyncExternalStore } from "react";
import { canEditFilePreview } from "./fileEditEligibility";
import {
  fileEditKey,
  getFileEditDraft,
  observeFileEditRead,
  subscribeFileEditDraft,
} from "./fileEditDrafts";

interface UseFileEditDraftInput {
  readonly cwd: string;
  readonly relativePath: string;
  readonly executionTargetId?: string | undefined;
  readonly preview: {
    readonly loaded: boolean;
    readonly contents: string;
    readonly sha256: string | null;
    readonly sizeBytes: number | null;
    readonly truncated: boolean;
  };
}

export function useFileEditDraft({
  cwd,
  relativePath,
  executionTargetId,
  preview,
}: UseFileEditDraftInput) {
  const draftKey = fileEditKey(cwd, relativePath, executionTargetId);
  const draft = useSyncExternalStore(
    useCallback((listener) => subscribeFileEditDraft(draftKey, listener), [draftKey]),
    useCallback(() => getFileEditDraft(draftKey), [draftKey]),
  );
  const verifiedFromRead = canEditFilePreview({
    executionTargetId,
    sha256: preview.sha256,
    sizeBytes: preview.sizeBytes,
    truncated: preview.truncated,
  });
  const eligible =
    verifiedFromRead ||
    Boolean(
      draft &&
      !preview.loaded &&
      canEditFilePreview({
        executionTargetId,
        sha256: draft.baseHash,
        sizeBytes: new TextEncoder().encode(draft.baseContents).byteLength,
        truncated: false,
      }),
    );
  useEffect(() => {
    if (!verifiedFromRead || !preview.sha256) return;
    observeFileEditRead({
      cwd,
      relativePath,
      ...(executionTargetId ? { executionTargetId } : {}),
      contents: preview.contents,
      sha256: preview.sha256,
    });
  }, [cwd, verifiedFromRead, executionTargetId, relativePath, preview.contents, preview.sha256]);
  return { draftKey, draft, eligible };
}
