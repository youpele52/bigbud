import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { ProjectFileEditCapability } from "@bigbud/contracts/workspace/project";
import {
  canEditFilePreview,
  canReconcileFilePreview,
  fileEditReadOnlyReason,
} from "./fileEditEligibility";
import {
  fileEditKey,
  getFileEditDraft,
  invalidateFileEditRead,
  observeFileEditRead,
  subscribeFileEditDraft,
} from "./fileEditDrafts";

interface UseFileEditDraftInput {
  readonly cwd: string;
  readonly relativePath: string;
  readonly executionTargetId?: string | undefined;
  readonly editing: boolean;
  readonly refreshPreview: () => Promise<void>;
  readonly preview: {
    readonly loaded: boolean;
    readonly loading: boolean;
    readonly contents: string;
    readonly sha256: string | null;
    readonly edit: ProjectFileEditCapability | null;
    readonly sizeBytes: number | null;
    readonly truncated: boolean;
    readonly readVersion: number;
    readonly readEpoch: number;
    readonly error: string | null;
    readonly refreshError: string | null;
  };
}

export function useFileEditDraft({
  cwd,
  relativePath,
  executionTargetId,
  editing,
  refreshPreview,
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
    edit: preview.edit,
  });
  const eligible =
    verifiedFromRead ||
    Boolean(
      draft &&
      (draft.status !== "saved" || editing || !preview.loaded) &&
      canEditFilePreview({
        executionTargetId,
        sha256: draft.baseHash,
        sizeBytes: new TextEncoder().encode(draft.baseContents).byteLength,
        truncated: false,
        edit: preview.edit,
      }),
    );
  useEffect(() => {
    if (preview.loading) return;
    if (preview.error || preview.refreshError) {
      invalidateFileEditRead(draftKey);
      return;
    }
    if (!preview.readVersion) return;
    if (
      !preview.sha256 ||
      !canReconcileFilePreview({
        executionTargetId,
        sha256: preview.sha256,
        sizeBytes: preview.sizeBytes,
        truncated: preview.truncated,
        edit: preview.edit,
      })
    ) {
      invalidateFileEditRead(draftKey);
      return;
    }
    observeFileEditRead({
      cwd,
      relativePath,
      ...(executionTargetId ? { executionTargetId } : {}),
      contents: preview.contents,
      sha256: preview.sha256,
      readEpoch: preview.readEpoch,
    });
  }, [
    cwd,
    draftKey,
    executionTargetId,
    relativePath,
    preview.contents,
    preview.sha256,
    preview.sizeBytes,
    preview.truncated,
    preview.edit,
    preview.readVersion,
    preview.readEpoch,
    preview.error,
    preview.refreshError,
    preview.loading,
  ]);
  useEffect(() => {
    if (draft?.needsVerification) void refreshPreview();
  }, [draft?.verificationEpoch, draft?.needsVerification, refreshPreview]);
  const readOnlyReason = eligible
    ? null
    : fileEditReadOnlyReason({ executionTargetId, edit: preview.edit });
  return { draftKey, draft, eligible, readOnlyReason };
}
