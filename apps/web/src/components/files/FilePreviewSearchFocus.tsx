import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo } from "react";

import { useSearchStore } from "~/stores/ui/search.store";

interface FilePreviewSearchFocusProps {
  readonly path: string;
  readonly contents: string;
  readonly enabled: boolean;
  readonly onSelectMatch: (line: number) => void;
  readonly children: ReactNode;
  readonly className: string;
}

export function FilePreviewSearchFocus({
  path,
  contents,
  enabled,
  onSelectMatch,
  children,
  className,
}: FilePreviewSearchFocusProps) {
  const setFileSearchContext = useSearchStore((state) => state.setFileSearchContext);
  const clearFileSearchContext = useSearchStore((state) => state.clearFileSearchContext);
  const context = useMemo(
    () => ({ path, contents, onSelectMatch }),
    [contents, onSelectMatch, path],
  );
  const activate = useCallback(() => {
    if (enabled) setFileSearchContext(context);
  }, [context, enabled, setFileSearchContext]);

  useEffect(() => () => clearFileSearchContext(context), [clearFileSearchContext, context]);

  return (
    <div
      className={className}
      data-file-preview-search-focus
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          clearFileSearchContext(context);
        }
      }}
      onFocusCapture={activate}
      onMouseDown={activate}
    >
      {children}
    </div>
  );
}
