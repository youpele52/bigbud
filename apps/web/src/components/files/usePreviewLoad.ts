import { useCallback, useEffect, useRef, useState } from "react";
import { readNativeApi } from "../../rpc/nativeApi";
import { getFileEditReadEpoch } from "./fileEditDrafts.state";

interface PreviewState {
  fileKey: string | null;
  loading: boolean;
  loaded: boolean;
  contents: string;
  truncated: boolean;
  sizeBytes: number | null;
  sha256: string | null;
  error: string | null;
  refreshError: string | null;
  readVersion: number;
  readEpoch: number;
}

interface UsePreviewLoadInput {
  cwd: string;
  relativePath: string;
  executionTargetId?: string | undefined;
  onLoadError?: ((error: unknown) => void) | undefined;
}

const INITIAL_STATE: PreviewState = {
  fileKey: null,
  loading: true,
  loaded: false,
  contents: "",
  truncated: false,
  sizeBytes: null,
  sha256: null,
  error: null,
  refreshError: null,
  readVersion: 0,
  readEpoch: 0,
};

export function usePreviewLoad({
  cwd,
  relativePath,
  executionTargetId,
  onLoadError,
}: UsePreviewLoadInput) {
  const fileKey = JSON.stringify([executionTargetId ?? null, cwd, relativePath]);
  const [state, setState] = useState<PreviewState>(INITIAL_STATE);
  const previewRequestIdRef = useRef(0);

  const loadPreview = useCallback(
    (options?: { readonly preserveContents?: boolean }): Promise<void> => {
      const requestId = ++previewRequestIdRef.current;
      const readEpoch = getFileEditReadEpoch(fileKey);
      const preserveContents = options?.preserveContents ?? false;

      setState((current) =>
        preserveContents
          ? {
              ...current,
              loading: true,
              refreshError: null,
            }
          : { ...INITIAL_STATE, fileKey },
      );

      const api = readNativeApi();
      if (!api) {
        setState((current) => {
          if (requestId !== previewRequestIdRef.current) {
            return current;
          }

          if (preserveContents && current.loaded) {
            return {
              ...current,
              loading: false,
              refreshError: "Native API not found.",
            };
          }

          return {
            fileKey,
            loading: false,
            loaded: false,
            contents: "",
            truncated: false,
            sizeBytes: null,
            sha256: null,
            error: "Native API not found.",
            refreshError: null,
            readVersion: 0,
            readEpoch,
          };
        });
        return Promise.resolve();
      }

      return api.projects
        .readFilePreview({
          cwd,
          relativePath,
          ...(executionTargetId ? { executionTargetId } : {}),
        })
        .then((result) => {
          setState((current) => {
            if (requestId !== previewRequestIdRef.current) {
              return current;
            }

            return {
              fileKey,
              loading: false,
              loaded: true,
              contents: result.contents,
              truncated: result.truncated,
              sizeBytes: result.sizeBytes ?? null,
              sha256: result.sha256 ?? null,
              error: null,
              refreshError: null,
              readVersion: requestId,
              readEpoch,
            };
          });
        })
        .catch((error) => {
          if (requestId !== previewRequestIdRef.current) return;
          onLoadError?.(error);
          const message = error instanceof Error ? error.message : "Failed to load preview.";

          setState((current) => {
            if (requestId !== previewRequestIdRef.current) {
              return current;
            }

            if (preserveContents && current.loaded) {
              return {
                ...current,
                loading: false,
                refreshError: message,
              };
            }

            return {
              fileKey,
              loading: false,
              loaded: false,
              contents: "",
              truncated: false,
              sizeBytes: null,
              sha256: null,
              error: message,
              refreshError: null,
              readVersion: 0,
              readEpoch,
            };
          });
        });
    },
    [cwd, executionTargetId, fileKey, onLoadError, relativePath],
  );

  useEffect(
    () => () => {
      ++previewRequestIdRef.current;
    },
    [loadPreview],
  );

  const refreshPreview = useCallback(() => {
    return loadPreview({ preserveContents: true });
  }, [loadPreview]);

  return { state: state.fileKey === fileKey ? state : INITIAL_STATE, loadPreview, refreshPreview };
}
