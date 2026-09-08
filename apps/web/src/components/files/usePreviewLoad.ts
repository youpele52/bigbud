import { useCallback, useRef, useState } from "react";
import { readNativeApi } from "../../rpc/nativeApi";

interface PreviewState {
  loading: boolean;
  loaded: boolean;
  contents: string;
  truncated: boolean;
  error: string | null;
}

interface UsePreviewLoadInput {
  cwd: string;
  relativePath: string;
  executionTargetId?: string | undefined;
  onLoadError?: ((error: unknown) => void) | undefined;
}

const INITIAL_STATE: PreviewState = {
  loading: true,
  loaded: false,
  contents: "",
  truncated: false,
  error: null,
};

export function usePreviewLoad({
  cwd,
  relativePath,
  executionTargetId,
  onLoadError,
}: UsePreviewLoadInput) {
  const [state, setState] = useState<PreviewState>(INITIAL_STATE);
  const previewRequestIdRef = useRef(0);

  const loadPreview = useCallback(
    (options?: { readonly preserveContents?: boolean }): Promise<void> => {
      const requestId = ++previewRequestIdRef.current;
      const preserveContents = options?.preserveContents ?? false;

      setState((current) =>
        preserveContents
          ? {
              ...current,
              loading: true,
            }
          : INITIAL_STATE,
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
            };
          }

          return {
            loading: false,
            loaded: false,
            contents: "",
            truncated: false,
            error: "Native API not found.",
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
              loading: false,
              loaded: true,
              contents: result.contents,
              truncated: result.truncated,
              error: null,
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
              };
            }

            return {
              loading: false,
              loaded: false,
              contents: "",
              truncated: false,
              error: message,
            };
          });
        });
    },
    [cwd, executionTargetId, onLoadError, relativePath],
  );

  const refreshPreview = useCallback(() => {
    return loadPreview({ preserveContents: true });
  }, [loadPreview]);

  return { state, loadPreview, refreshPreview };
}
